/**
 * `agentic-daemon pair <code> --url <platform> [--name <machine>] [--allow-root <dir>…]`
 * `agentic-daemon run [--verbose] [--quota-probe on|off] [--quota-poll-ms <ms>] [--telemetry on|off]`
 * `agentic-daemon doctor`
 * `agentic-daemon open [path] [--env <id>] [--no-browser]` (`open.ts`)
 * `agentic-daemon env add | list | rm | login` (`env-cli.ts`)
 * `agentic-daemon launcher install | remove | show` (`launcher.ts`)
 * `agentic-daemon policy show | allow-root | deny-root | off` (`policy-cli.ts`)
 * `agentic-daemon update [--channel stable|latest] [--version daemon-v…] [--check] [--now]` (`update-cli.ts`)
 * `agentic-daemon harness list | install | update | rm` (`harness-cli.ts`)
 * `agentic-daemon --version` (also `version`)
 *
 * Everything the CLI touches — paths, fetch, drivers, the output streams, the
 * stop signal — is injectable, so the commands are tested end to end without
 * a real profile directory or a real process exit.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { DaemonExit, DaemonUpdateOutcome, QuotaSource } from '@agentic/core';
import { registeredChildren, killTreeSync } from '@sigx/ai-agent-node';
import { credentialSecrets, loadCredentials, saveCredentials, type CommandRunner, type Credentials } from './credentials.js';
import { createDaemon, type Daemon, type DaemonDriver } from './daemon.js';
import { builtinRuntimes, isDisposable } from './drivers.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { envCommand, ENV_USAGE, flagValues, type LoginRunner } from './env-cli.js';
import { harnessCommand, HARNESS_USAGE } from './harness-cli.js';
import { DEFAULT_RELEASES, harnessRoot, harnessStore, releaseManifestUrl, type HarnessStore } from './harness.js';
import { watchEnvironments } from './env-store.js';
import { loadEnvironments } from './environments.js';
import { ndjsonEventLog } from './event-log.js';
import { describeLauncher, installLauncher, launcherPlan, removeLauncher, type LauncherContext } from './launcher.js';
import { createLogger, redact, type Logger, type LogLevel } from './logger.js';
import { openUrl, resolveOpen, type UrlOpener } from './open.js';
import { pair, PairingError } from './pair.js';
import { daemonPaths, installPaths, type DaemonPaths, type InstallPaths } from './paths.js';
import { policyCommand, POLICY_USAGE } from './policy-cli.js';
import { applyWebPolicy, browseMachine } from './policy-web.js';
import { allowRoot, loadPolicy, localEdit, POLICY_OFF, PolicyError, watchPolicy, writePolicy } from './policy.js';
import { isSupervised, updateCommand, UPDATE_USAGE, type UpdateTestOptions } from './update-cli.js';
import { DAEMON_CHANNEL, DAEMON_VERSION, versionLine } from './version.js';

export interface CliContext {
    readonly paths?: DaemonPaths;
    readonly drivers?: readonly DaemonDriver[];
    /**
     * The harness store (#369). Default: `<install root>/harnesses` with the built-in drivers (which are built from it),
     * none with injected drivers or with `paths` and no `install` — then the SDKs find their native builds their own way,
     * `run` answers no `harness.request` and `harness` has nothing to act on.
     */
    readonly harnesses?: HarnessStore;
    /** The `quota` sources `run` reads provider limits with; the built-in set's with the built-in drivers, none with injected ones. */
    readonly quotaSources?: readonly QuotaSource[];
    readonly fetch?: typeof fetch;
    readonly out?: (text: string) => void;
    readonly err?: (text: string) => void;
    /** Log lines (JSON); default `err`. */
    readonly log?: (line: string) => void;
    /**
     * `run` stops when this resolves — with `'update'` it exits `EXIT_UPDATE` (the supervisor applies the staged
     * update), with `'signal'` it stops the way SIGINT / SIGTERM do (sessions closed with code `restart`, #363);
     * default SIGINT / SIGTERM.
     */
    readonly until?: Promise<void | 'update' | 'signal'>;
    /**
     * Where `run` hears `uncaughtException` / `unhandledRejection` and how it exits on one: it logs
     * `daemon: exiting` and exits 1. Default `process` — unless `until` is injected (tests), then none.
     */
    readonly host?: CrashHost;
    /**
     * The install root's `state/` (#362): `run` writes `ready` after the first `welcome` and reads what the
     * supervisor left there. Default `installPaths()` — unless `paths` is injected (tests), then none.
     */
    readonly install?: InstallPaths;
    readonly platform?: NodeJS.Platform;
    /** What `~` in a web-set policy expands to (#355; tests). Default `os.homedir()`. */
    readonly home?: string;
    readonly run?: CommandRunner;
    readonly hostname?: string;
    /** Called once `run` has started the daemon (tests). */
    readonly onStarted?: (daemon: Daemon) => void;
    readonly heartbeatMs?: number;
    readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number };
    /** How long `run` waits for `environments.json` to settle before re-reading it. Default 250 ms. */
    readonly watchDebounceMs?: number;
    /** `DaemonOptions.reinspectMs`. */
    readonly reinspectMs?: number;
    /** `env login`'s sign-in process (tests). */
    readonly login?: LoginRunner;
    /** `open`'s browser launcher (tests); default the OS opener (`openUrl`). */
    readonly opener?: UrlOpener;
    /** `open`'s default folder; default `process.cwd()`. */
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** `update` and the update client in `run` (#364): tests only — timings, the staged `--version` run, `http:` on the loopback. */
    readonly update?: UpdateTestOptions;
}

const LAUNCHER_USAGE = `  agentic-daemon launcher install [--node <path>] [--entry <path>] [--bin-dir <dir>] [--no-profile]
                       (the \`agentic-daemon\` command itself: written by the installer, on PATH for a new shell.
                        --node / --entry override the Node and the bin/agentic-daemon.mjs it runs, both taken
                        from this process otherwise; --no-profile writes it but changes no shell profile or user PATH)
  agentic-daemon launcher remove
  agentic-daemon launcher show`;

const USAGE = `agentic-daemon ${DAEMON_VERSION}

Usage:
  agentic-daemon pair <code> --url <platform> [--name <machine name>] [--allow-root <dir>…]
                       (--allow-root lets the web add environments inside <dir>)
  agentic-daemon run [--verbose] [--quota-probe on|off] [--quota-poll-ms <ms>] [--telemetry on|off]
                       (--quota-probe off: usage limits from running sessions only, no account probes;
                        --telemetry off: no CPU and memory per session reported to the platform)
  agentic-daemon doctor
  agentic-daemon open [path] [--env <id>] [--no-browser]
                       (start a chat in this folder: prints the link, opens the browser; --env picks
                        the environment when the folder is under several; --no-browser only prints)
${ENV_USAGE}
${HARNESS_USAGE}
${POLICY_USAGE}
${LAUNCHER_USAGE}
${UPDATE_USAGE}
  agentic-daemon --version
`;

/** The daemon's exit code for "apply the staged update" — the supervisor swaps `daemon.staged` in (`scripts/supervise.mjs`). */
export const EXIT_UPDATE = 75;

/** Why `run` ended, logged as `daemon: exiting { reason, code }` on every exit path (#353, #362). */
export type ExitReason = 'signal' | 'stop' | 'update' | 'uncaught' | 'unhandled-rejection' | 'config' | 'error';

export interface CrashHost {
    on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown;
    off(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown;
    exit(code: number): void;
}

/** What the supervisor left in `state/`: its restart count and the daemon's last exit, and the last rolled-back update. */
export interface SupervisorState {
    readonly restarts?: number;
    readonly lastExit?: { readonly at: number; readonly code: number | null; readonly signal: string | null };
    readonly lastUpdate?: { readonly from: string | null; readonly to: string | null; readonly at: number; readonly reason: string };
}

/** `state/supervisor.json` and `state/update-failed.json`; a missing or unreadable file is simply absent. */
export async function readSupervisorState(install: Pick<InstallPaths, 'supervisorFile' | 'updateFailedFile'>): Promise<SupervisorState> {
    const json = async (file: string): Promise<Record<string, unknown> | undefined> => {
        try {
            const value: unknown = JSON.parse(await readFile(file, 'utf8'));
            return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
        } catch {
            return undefined;
        }
    };
    const supervisor = await json(install.supervisorFile);
    const failed = await json(install.updateFailedFile);
    return {
        ...(typeof supervisor?.restarts === 'number' ? { restarts: supervisor.restarts } : {}),
        ...(supervisor?.lastExit && typeof supervisor.lastExit === 'object' ? { lastExit: supervisor.lastExit as SupervisorState['lastExit'] } : {}),
        ...(failed && typeof failed.reason === 'string' ? { lastUpdate: failed as unknown as SupervisorState['lastUpdate'] } : {})
    };
}

/**
 * What `hello` reports of the supervisor's state (#364): the restart count, the last exit (`update` for 75, `signal`,
 * `stop` for 0, `crash` otherwise) and a rolled-back update.
 */
export function helloLifecycle(state: SupervisorState): { restarts?: number; lastExit?: DaemonExit; lastUpdate?: DaemonUpdateOutcome } {
    const exit = state.lastExit;
    const failed = state.lastUpdate;
    return {
        ...(state.restarts !== undefined ? { restarts: state.restarts } : {}),
        ...(exit && typeof exit.at === 'number'
            ? { lastExit: { at: exit.at, reason: exit.code === EXIT_UPDATE ? 'update' : exit.signal ? `signal ${exit.signal}` : exit.code === 0 ? 'stop' : 'crash', ...(typeof exit.code === 'number' ? { code: exit.code } : {}) } }
            : {}),
        ...(failed && typeof failed.at === 'number' ? { lastUpdate: { from: failed.from ?? 'unknown', to: failed.to ?? 'unknown', outcome: 'rolled-back' as const, at: failed.at, error: failed.reason } } : {})
    };
}

export interface ParsedArgs {
    readonly command: string | undefined;
    readonly positional: readonly string[];
    readonly flags: Readonly<Record<string, string | true>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    const flags: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg.startsWith('--')) {
            const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
            if (inline !== undefined) flags[key] = inline;
            else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[key] = argv[++i]!;
            else flags[key] = true;
        } else positional.push(arg);
    }
    return { command: positional[0], positional: positional.slice(1), flags };
}

/** `--quota-probe on|off` and `--quota-poll-ms <ms>` (#271); a message when either is malformed. */
export function quotaFlags(flags: ParsedArgs['flags']): { probe?: boolean; pollMs?: number } | string {
    const out: { probe?: boolean; pollMs?: number } = {};
    const probe = flags['quota-probe'];
    if (probe !== undefined) {
        if (probe !== 'on' && probe !== 'off') return '--quota-probe takes on or off';
        out.probe = probe === 'on';
    }
    const poll = flags['quota-poll-ms'];
    if (poll !== undefined) {
        const ms = typeof poll === 'string' && /^\d+$/.test(poll) ? Number(poll) : NaN;
        if (!Number.isSafeInteger(ms)) return '--quota-poll-ms takes a whole number of milliseconds (0 turns the poll off)';
        out.pollMs = ms;
    }
    return out;
}

/** `--telemetry on|off` (#400); a message when it is malformed. */
export function telemetryFlags(flags: ParsedArgs['flags']): { enabled?: boolean } | string {
    const value = flags['telemetry'];
    if (value === undefined) return {};
    if (value !== 'on' && value !== 'off') return '--telemetry takes on or off';
    return { enabled: value === 'on' };
}

function stopSignal(): Promise<'signal'> {
    return new Promise((resolve) => {
        const done = () => {
            process.off('SIGINT', done);
            process.off('SIGTERM', done);
            resolve('signal');
        };
        process.on('SIGINT', done);
        process.on('SIGTERM', done);
    });
}

export async function main(argv: readonly string[], context: CliContext = {}): Promise<number> {
    const out = context.out ?? ((t: string) => process.stdout.write(`${t}\n`));
    const err = context.err ?? ((t: string) => process.stderr.write(`${t}\n`));
    const paths = context.paths ?? daemonPaths(context.platform ? { platform: context.platform } : {});
    const pathContext = { ...(context.platform ? { platform: context.platform } : {}), ...(context.env ? { env: context.env } : {}) };
    // Where the harnesses are (#369): the built-in drivers run what the store locates. Like `install`, none by default when `paths` is injected (tests).
    const installation = context.install ?? (context.paths ? undefined : installPaths(pathContext));
    const harnesses = context.harnesses ?? (context.drivers || !installation ? undefined : harnessStore({ root: harnessRoot(installation) }));
    // One set, so a quota source that asks a runtime shares the driver's process for it. Only with the built-in
    // drivers: sources over drivers `run` does not own would hold processes nothing disposes. Building the set
    // starts nothing — a driver spawns its runtime on first use.
    const builtin = context.drivers ? undefined : builtinRuntimes(harnesses ? { harnesses } : {});
    const drivers = context.drivers ?? builtin!.drivers;
    const args = parseArgs(argv);
    let secrets: string[] = [];
    const logger = (level: LogLevel): Logger => createLogger({ level, write: context.log ?? err, secrets: () => secrets });
    const secure = { ...(context.platform ? { platform: context.platform } : {}), ...(context.run ? { run: context.run } : {}) };
    /** `run`'s logger once it has one: the outer catch logs the `error` exit with it. */
    let runLog: Logger | undefined;

    if (args.command === undefined && args.flags.version === true) {
        out(versionLine());
        return 0;
    }
    try {
        switch (args.command) {
            case 'version':
                out(versionLine());
                return 0;
            case 'pair': {
                const code = args.positional[0];
                const url = args.flags.url;
                if (!code || typeof url !== 'string') {
                    err(USAGE);
                    return 2;
                }
                const name = typeof args.flags.name === 'string' ? args.flags.name : (context.hostname ?? hostname());
                // Every folder is checked before the code is spent: a typo must not cost a pairing.
                const allow = flagValues(argv, 'allow-root');
                if (args.flags['allow-root'] === true && allow.length === 0) {
                    err(`--allow-root needs a folder\n\n${USAGE}`);
                    return 2;
                }
                let policy = POLICY_OFF;
                if (allow.length > 0) {
                    const loaded = await loadPolicy(paths.policyFile);
                    policy = loaded.ok ? loaded.policy : POLICY_OFF;
                    try {
                        for (const dir of allow) policy = await allowRoot(policy, dir, { configDir: paths.configDir, stateDir: paths.stateDir }, context.platform);
                    } catch (e) {
                        if (!(e instanceof PolicyError)) throw e;
                        err(`--allow-root: ${e.message}`);
                        return 1;
                    }
                }
                const result = await pair({ url, code, name, ...(context.fetch ? { fetch: context.fetch } : {}) });
                secrets = credentialSecrets(result);
                const credentials: Credentials = { ...result, name, pairedAt: Date.now() };
                await saveCredentials(paths.credentialsFile, credentials, secure);
                out(`paired as machine ${result.machineId} (workspace ${result.workspaceId}); credentials saved to ${paths.credentialsFile}`);
                if (allow.length > 0) {
                    await writePolicy(paths.policyFile, localEdit(policy), secure);
                    out(`the web may add environments inside: ${policy.allowedRoots.join(', ')} (change it with \`agentic-daemon policy\`)`);
                }
                return 0;
            }
            case 'run': {
                const log = logger(args.flags.verbose ? 'debug' : 'info');
                runLog = log;
                const exiting = (reason: ExitReason, code: number, fields: Record<string, unknown> = {}): number => {
                    log.info('daemon: exiting', { reason, code, ...fields });
                    return code;
                };
                const credentials = await loadCredentials(paths.credentialsFile);
                if (!credentials) {
                    err(`not paired — run \`agentic-daemon pair <code> --url <platform>\` first`);
                    return exiting('config', 1, { problem: 'not paired' });
                }
                secrets = credentialSecrets(credentials);
                const quota = quotaFlags(args.flags);
                if (typeof quota === 'string') {
                    err(`${quota}\n\n${USAGE}`);
                    return exiting('config', 2, { problem: quota });
                }
                const telemetry = telemetryFlags(args.flags);
                if (typeof telemetry === 'string') {
                    err(`${telemetry}\n\n${USAGE}`);
                    return exiting('config', 2, { problem: telemetry });
                }
                const loaded = await loadEnvironments(paths.environmentsFile);
                if (!loaded.ok) {
                    for (const e of loaded.errors) log.error('environments.json is invalid', { problem: e });
                    return exiting('config', 1, { problem: 'environments.json is invalid' });
                }
                const install = installation;
                const state = install ? await readSupervisorState(install) : {};
                if (Object.keys(state).length > 0) log.info('supervisor state', { ...state });
                // Updates need the supervisor to swap the staged build in (#364): without it the daemon does not offer them.
                const supervised = install !== undefined && (await isSupervised(install, context.env ?? process.env));
                let requestUpdate!: () => void;
                const updateRequested = new Promise<'update'>((resolve) => (requestUpdate = () => resolve('update')));
                // A crash anywhere logs why before the process goes: the #353 exit left no line at all.
                const host = context.host ?? (context.until ? undefined : (process as unknown as CrashHost));
                const crash = (reason: 'uncaught' | 'unhandled-rejection') => (e: unknown) => {
                    exiting(reason, 1, { error: e, ...(e instanceof Error && e.stack ? { stack: e.stack } : {}) });
                    for (const child of registeredChildren()) killTreeSync(child);
                    host?.exit(1);
                };
                const onUncaught = crash('uncaught');
                const onRejection = crash('unhandled-rejection');
                host?.on('uncaughtException', onUncaught);
                host?.on('unhandledRejection', onRejection);
                let welcomed = false;
                const onWelcome = (): void => {
                    if (welcomed || !install) return;
                    welcomed = true;
                    // A rolled-back update is reported on this process's `hello`s, once: the next start does not repeat it.
                    if (state.lastUpdate) void rm(install.updateFailedFile, { force: true }).catch(() => {});
                    // The supervisor's go-ahead for a swapped-in version: this one reaches the platform.
                    void mkdir(install.stateDir, { recursive: true })
                        .then(() => writeFile(install.readyFile, `${JSON.stringify({ version: DAEMON_VERSION, pid: process.pid, at: Date.now() })}\n`))
                        .catch((e: unknown) => log.warn('cannot write the ready marker', { file: install.readyFile, error: e }));
                };
                // No file yet is a machine with nothing to offer, not a failure (#235): it connects and reports none.
                if (loaded.environments.length === 0) log.warn('no environments yet — add one with `agentic-daemon env add`; this daemon picks it up while running', { file: paths.environmentsFile });
                // An unreadable policy is off: web management fails closed.
                const loadedPolicy = await loadPolicy(paths.policyFile);
                /** What the daemon runs with, as the file spells it: the watcher announces only a change to it. */
                let runningPolicy = '';
                const profileDirsOf = (envs: readonly { readonly profileDir?: string }[]) => [join(paths.configDir, 'profiles'), ...envs.flatMap((e) => (e.profileDir === undefined ? [] : [e.profileDir]))];
                if (!loadedPolicy.ok) for (const e of loadedPolicy.errors) log.error('policy.json is invalid; the web manages nothing on this machine', { problem: e });
                if (harnesses) {
                    for (const report of harnesses.reports(drivers.map((d) => d.runtime))) log.info('harness', { ...report });
                    // Versions a terminal install left behind: nothing runs them now.
                    for (const d of drivers) {
                        const leftovers = await harnesses.prune(d.runtime).catch(() => []);
                        if (leftovers.length) log.warn('harness: old versions could not be removed', { runtime: d.runtime, leftovers });
                    }
                }
                const daemon = createDaemon({
                    credentials,
                    environments: loaded.environments,
                    policy: loadedPolicy.ok ? loadedPolicy.policy : POLICY_OFF,
                    manage: { paths, secure },
                    // The web sets the policy (#355) through this port and nowhere else; what it wrote is already the
                    // running policy, so the file watcher below is told not to announce it a second time.
                    webPolicy: {
                        apply: async (input) => {
                            const outcome = await applyWebPolicy(input, { paths, profileDirs: profileDirsOf(daemon.environments), secure, logger: log, ...(context.home ? { home: context.home } : {}), ...(context.platform ? { platform: context.platform } : {}) });
                            if ('policy' in outcome) runningPolicy = JSON.stringify(outcome.policy);
                            return outcome;
                        },
                        browse: (path) => browseMachine(path, { paths, profileDirs: profileDirsOf(daemon.environments), logger: log, ...(context.home ? { home: context.home } : {}), ...(context.platform ? { platform: context.platform } : {}) })
                    },
                    drivers,
                    quota: { sources: context.quotaSources ?? builtin?.quotaSources ?? [], ...quota },
                    telemetry,
                    eventLog: ndjsonEventLog(paths.sessionsDir, { onError: (e, session) => log.error('session log write failed', { session, error: e }) }),
                    logger: log,
                    ...(context.heartbeatMs ? { heartbeatMs: context.heartbeatMs } : {}),
                    ...(context.backoff ? { backoff: context.backoff } : {}),
                    ...(context.reinspectMs !== undefined ? { reinspectMs: context.reinspectMs } : {}),
                    ...(context.platform ? { platform: context.platform } : {}),
                    onWelcome,
                    lifecycle: helloLifecycle(state),
                    ...(harnesses && builtin
                        ? {
                              harnesses: {
                                  store: harnesses,
                                  rebuild: builtin.rebuild,
                                  ...(context.fetch ? { fetch: context.fetch } : {}),
                                  // Under an install root, the selected harnesses this machine lacks come from its own channel (#369): the
                                  // migration from builds that bundled the runtimes, and a retry of whatever failed last time.
                                  ...(install
                                      ? { heal: { manifestUrl: releaseManifestUrl({ releases: (context.env ?? process.env).AGENTIC_RELEASES || DEFAULT_RELEASES, channel: DAEMON_CHANNEL === 'stable' ? 'stable' : 'latest' }) } }
                                      : {})
                              }
                          }
                        : {}),
                    ...(supervised && install
                        ? {
                              update: {
                                  root: install.root,
                                  restart: requestUpdate,
                                  ...(context.fetch ? { fetch: context.fetch } : {}),
                                  ...(context.update?.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
                                  ...(context.update?.check ? { check: context.update.check } : {}),
                                  ...(context.update?.pollMs !== undefined ? { pollMs: context.update.pollMs } : {})
                              }
                          }
                        : {})
                });
                await daemon.start();
                // `env add` / `env rm` / an edit reach the platform without a restart. An invalid file keeps the running set.
                const watcher = await watchEnvironments({
                    file: paths.environmentsFile,
                    ...(context.watchDebounceMs !== undefined ? { debounceMs: context.watchDebounceMs } : {}),
                    onError: (e) => log.warn('watching environments.json failed', { error: e }),
                    onChange: async (next) => {
                        if (!next.ok) {
                            for (const e of next.errors) log.error('environments.json is invalid; keeping the running environments', { problem: e });
                            return;
                        }
                        // What the daemon wrote for an `env.request` is already running and announced.
                        if (JSON.stringify(next.environments) === JSON.stringify(daemon.environments)) return;
                        await daemon.setEnvironments(next.environments);
                        log.info('environments reloaded', { environments: next.environments.length });
                    }
                }).catch((e: unknown) => {
                    log.warn('cannot watch environments.json; changes need a restart', { error: e });
                    return undefined;
                });
                // `agentic-daemon policy …` (or a hand edit) takes effect at once; a broken file turns web management off.
                runningPolicy = JSON.stringify(loadedPolicy.ok ? loadedPolicy.policy : POLICY_OFF);
                const policyWatcher = await watchPolicy({
                    file: paths.policyFile,
                    ...(context.watchDebounceMs !== undefined ? { debounceMs: context.watchDebounceMs } : {}),
                    onError: (e) => log.warn('watching policy.json failed', { error: e }),
                    onChange: async (next) => {
                        if (!next.ok) for (const e of next.errors) log.error('policy.json is invalid; the web manages nothing on this machine', { problem: e });
                        const policy = next.ok ? next.policy : POLICY_OFF;
                        const text = JSON.stringify(policy);
                        if (text === runningPolicy) return;
                        runningPolicy = text;
                        await daemon.setPolicy(policy);
                        log.info('policy reloaded', { webManaged: policy.webManaged, allowedRoots: policy.allowedRoots.length });
                    }
                }).catch((e: unknown) => {
                    log.warn('cannot watch policy.json; changes need a restart', { error: e });
                    return undefined;
                });
                context.onStarted?.(daemon);
                const ended = await Promise.race([context.until ?? stopSignal(), updateRequested]);
                const reason: ExitReason = ended === 'signal' ? 'signal' : ended === 'update' ? 'update' : 'stop';
                const code = exiting(reason, reason === 'update' ? EXIT_UPDATE : 0);
                watcher?.close();
                policyWatcher?.close();
                // SIGINT / SIGTERM: the supervisor (or the service manager) brings the daemon back, so the platform re-opens its sessions (#363).
                await daemon.stop({ reason: reason === 'signal' ? 'restart' : reason === 'update' ? 'update' : 'stop' });
                // The supervisor waits for the swapped-in version's own `ready` (#362, #364).
                if (reason === 'update' && install) await rm(install.readyFile, { force: true }).catch(() => {});
                // The drivers as they are now: a harness change rebuilt some (#369).
                for (const driver of builtin?.current() ?? drivers) if (isDisposable(driver)) await driver.dispose().catch((e: unknown) => log.warn('driver dispose failed', { runtime: driver.runtime, error: e }));
                // Runtime processes are spawned through @sigx/ai-agent-node and registered there: none may outlive the daemon.
                for (const child of registeredChildren()) killTreeSync(child);
                host?.off('uncaughtException', onUncaught);
                host?.off('unhandledRejection', onRejection);
                return code;
            }
            case 'open': {
                const credentials = await loadCredentials(paths.credentialsFile);
                if (!credentials) {
                    err(`not paired — run \`agentic-daemon pair <code> --url <platform>\` first`);
                    return 1;
                }
                secrets = credentialSecrets(credentials);
                if (args.flags.env === true) {
                    err(`--env needs an environment id\n\n${USAGE}`);
                    return 2;
                }
                const loaded = await loadEnvironments(paths.environmentsFile);
                if (!loaded.ok) {
                    for (const e of loaded.errors) err(`environments.json is invalid: ${e}`);
                    return 1;
                }
                // `open --no-browser <path>`: the parser reads the folder as the flag's value; it is the folder.
                const noBrowser = args.flags['no-browser'];
                const path = args.positional[0] ?? (typeof noBrowser === 'string' ? noBrowser : undefined);
                const resolved = await resolveOpen({
                    ...(path === undefined ? {} : { path }),
                    ...(typeof args.flags.env === 'string' ? { env: args.flags.env } : {}),
                    environments: loaded.environments,
                    url: credentials.url,
                    ...(context.platform ? { platform: context.platform } : {}),
                    ...(context.cwd ? { cwd: context.cwd } : {})
                });
                if (!resolved.ok) {
                    err(resolved.message);
                    return resolved.exitCode;
                }
                // The link first, always: it is the answer on a headless box or when no browser opens.
                out(resolved.url);
                if (noBrowser !== undefined) return 0;
                try {
                    await (context.opener ?? ((url: string) => openUrl(url, context.platform ?? process.platform)))(resolved.url);
                } catch (e) {
                    err(`could not open a browser (${(e as Error).message}); open the link above`);
                }
                return 0;
            }
            case 'env':
                return await envCommand(argv, args.positional[0], args.positional.slice(1), args.flags, {
                    paths,
                    drivers,
                    out,
                    err,
                    secure,
                    ...(context.login ? { login: context.login } : {}),
                    ...(context.env ? { env: context.env } : {}),
                    ...(harnesses ? { harnesses } : {})
                });
            case 'harness':
                if (!harnesses) {
                    err('this daemon manages no harnesses');
                    return 1;
                }
                return await harnessCommand(args.positional[0], args.positional.slice(1), args.flags, {
                    store: harnesses,
                    runtimes: drivers.map((d) => d.runtime),
                    paths,
                    out,
                    err,
                    ...(context.fetch ? { fetch: context.fetch } : {}),
                    ...(context.env ? { env: context.env } : {})
                });
            case 'policy':
                return await policyCommand(args.positional[0], args.positional.slice(1), { paths, out, err, secure, ...(context.platform ? { platform: context.platform } : {}) });
            case 'launcher': {
                const sub = args.positional[0];
                const launcher: LauncherContext = {
                    ...(context.platform ? { platform: context.platform } : {}),
                    ...(context.env ? { env: context.env } : {}),
                    ...(typeof args.flags.node === 'string' ? { node: args.flags.node } : {}),
                    ...(typeof args.flags.entry === 'string' ? { entry: args.flags.entry } : {}),
                    ...(typeof args.flags['bin-dir'] === 'string' ? { binDir: args.flags['bin-dir'] } : {}),
                    ...(args.flags['no-profile'] ? { profile: false } : {}),
                    ...(context.run ? { run: context.run } : {})
                };
                switch (sub) {
                    case 'install': {
                        const result = await installLauncher(launcher);
                        for (const note of result.notes) out(note);
                        return 0;
                    }
                    case 'remove': {
                        const result = await removeLauncher(launcher);
                        for (const note of result.notes) out(note);
                        return 0;
                    }
                    case 'show': {
                        const plan = launcherPlan(launcher);
                        const exists = async (file: string): Promise<boolean> => await stat(file).then(() => true, () => false);
                        out(describeLauncher(plan, { installed: await exists(plan.file), ...(plan.link ? { linked: await exists(plan.link) } : {}) }));
                        return 0;
                    }
                    default:
                        err(`${sub ? `unknown launcher command "${sub}"` : 'launcher needs a command'}\n\n${LAUNCHER_USAGE}`);
                        return 2;
                }
            }
            case 'update':
                return await updateCommand(args.flags, {
                    install: context.install ?? installPaths({ ...(context.platform ? { platform: context.platform } : {}), ...(context.env ? { env: context.env } : {}) }),
                    out,
                    err,
                    env: context.env ?? process.env,
                    ...(context.fetch ? { fetch: context.fetch } : {}),
                    ...(context.update ? { test: context.update } : {})
                });
            case 'doctor': {
                const report = await runDoctor({ paths, drivers, ...(harnesses ? { harnesses } : {}) });
                // The checks may have started runtimes (a Copilot client, a Codex app-server): none may keep the process alive.
                for (const driver of builtin?.current() ?? []) if (isDisposable(driver)) await driver.dispose().catch(() => undefined);
                for (const child of registeredChildren()) killTreeSync(child);
                out(formatDoctorReport(report));
                return report.ok ? 0 : 1;
            }
            case undefined:
            case 'help':
                out(USAGE);
                return args.command ? 0 : 2;
            default:
                err(`unknown command "${args.command}"\n\n${USAGE}`);
                return 2;
        }
    } catch (e) {
        runLog?.info('daemon: exiting', { reason: 'error' satisfies ExitReason, code: 1, error: e });
        const message = e instanceof PairingError ? `pairing failed: ${e.message}` : `agentic-daemon ${args.command ?? ''}: ${(e as Error).message}`;
        err(redact(message, secrets));
        return 1;
    }
}
