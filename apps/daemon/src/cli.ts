/**
 * `agentic-daemon pair <code> --url <platform> [--name <machine>]`
 * `agentic-daemon run [--verbose]`
 * `agentic-daemon doctor`
 * `agentic-daemon env add | list | rm | login` (`env-cli.ts`)
 * `agentic-daemon --version` (also `version`)
 *
 * Everything the CLI touches — paths, fetch, drivers, the output streams, the
 * stop signal — is injectable, so the commands are tested end to end without
 * a real profile directory or a real process exit.
 */

import { hostname } from 'node:os';
import { registeredChildren, killTreeSync } from '@sigx/ai-agent-node';
import { credentialSecrets, loadCredentials, saveCredentials, type CommandRunner, type Credentials } from './credentials.js';
import { createDaemon, type Daemon, type DaemonDriver } from './daemon.js';
import { builtinDrivers, isDisposable } from './drivers.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { envCommand, ENV_USAGE, type LoginRunner } from './env-cli.js';
import { watchEnvironments } from './env-store.js';
import { loadEnvironments } from './environments.js';
import { ndjsonEventLog } from './event-log.js';
import { createLogger, redact, type Logger, type LogLevel } from './logger.js';
import { pair, PairingError } from './pair.js';
import { daemonPaths, type DaemonPaths } from './paths.js';
import { DAEMON_VERSION } from './version.js';

export interface CliContext {
    readonly paths?: DaemonPaths;
    readonly drivers?: readonly DaemonDriver[];
    readonly fetch?: typeof fetch;
    readonly out?: (text: string) => void;
    readonly err?: (text: string) => void;
    /** Log lines (JSON); default `err`. */
    readonly log?: (line: string) => void;
    /** `run` stops when this resolves; default SIGINT / SIGTERM. */
    readonly until?: Promise<void>;
    readonly platform?: NodeJS.Platform;
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
    readonly env?: Readonly<Record<string, string | undefined>>;
}

const USAGE = `agentic-daemon ${DAEMON_VERSION}

Usage:
  agentic-daemon pair <code> --url <platform> [--name <machine name>]
  agentic-daemon run [--verbose]
  agentic-daemon doctor
${ENV_USAGE}
  agentic-daemon --version
`;

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

function stopSignal(): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            process.off('SIGINT', done);
            process.off('SIGTERM', done);
            resolve();
        };
        process.on('SIGINT', done);
        process.on('SIGTERM', done);
    });
}

export async function main(argv: readonly string[], context: CliContext = {}): Promise<number> {
    const out = context.out ?? ((t: string) => process.stdout.write(`${t}\n`));
    const err = context.err ?? ((t: string) => process.stderr.write(`${t}\n`));
    const paths = context.paths ?? daemonPaths(context.platform ? { platform: context.platform } : {});
    const drivers = context.drivers ?? builtinDrivers();
    const args = parseArgs(argv);
    let secrets: string[] = [];
    const logger = (level: LogLevel): Logger => createLogger({ level, write: context.log ?? err, secrets: () => secrets });

    if (args.command === undefined && args.flags.version === true) {
        out(`agentic-daemon ${DAEMON_VERSION}`);
        return 0;
    }
    try {
        switch (args.command) {
            case 'version':
                out(`agentic-daemon ${DAEMON_VERSION}`);
                return 0;
            case 'pair': {
                const code = args.positional[0];
                const url = args.flags.url;
                if (!code || typeof url !== 'string') {
                    err(USAGE);
                    return 2;
                }
                const name = typeof args.flags.name === 'string' ? args.flags.name : (context.hostname ?? hostname());
                const result = await pair({ url, code, name, ...(context.fetch ? { fetch: context.fetch } : {}) });
                secrets = credentialSecrets(result);
                const credentials: Credentials = { ...result, name, pairedAt: Date.now() };
                await saveCredentials(paths.credentialsFile, credentials, { ...(context.platform ? { platform: context.platform } : {}), ...(context.run ? { run: context.run } : {}) });
                out(`paired as machine ${result.machineId} (workspace ${result.workspaceId}); credentials saved to ${paths.credentialsFile}`);
                return 0;
            }
            case 'run': {
                const credentials = await loadCredentials(paths.credentialsFile);
                if (!credentials) {
                    err(`not paired — run \`agentic-daemon pair <code> --url <platform>\` first`);
                    return 1;
                }
                secrets = credentialSecrets(credentials);
                const log = logger(args.flags.verbose ? 'debug' : 'info');
                const loaded = await loadEnvironments(paths.environmentsFile);
                if (!loaded.ok) {
                    for (const e of loaded.errors) log.error('environments.json is invalid', { problem: e });
                    return 1;
                }
                // No file yet is a machine with nothing to offer, not a failure (#235): it connects and reports none.
                if (loaded.environments.length === 0) log.warn('no environments yet — add one with `agentic-daemon env add`; this daemon picks it up while running', { file: paths.environmentsFile });
                let running = JSON.stringify(loaded.environments);
                const daemon = createDaemon({
                    credentials,
                    environments: loaded.environments,
                    drivers,
                    eventLog: ndjsonEventLog(paths.sessionsDir, { onError: (e, session) => log.error('session log write failed', { session, error: e }) }),
                    logger: log,
                    ...(context.heartbeatMs ? { heartbeatMs: context.heartbeatMs } : {}),
                    ...(context.backoff ? { backoff: context.backoff } : {}),
                    ...(context.reinspectMs !== undefined ? { reinspectMs: context.reinspectMs } : {}),
                    ...(context.platform ? { platform: context.platform } : {})
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
                        const text = JSON.stringify(next.environments);
                        if (text === running) return;
                        running = text;
                        await daemon.setEnvironments(next.environments);
                        log.info('environments reloaded', { environments: next.environments.length });
                    }
                }).catch((e: unknown) => {
                    log.warn('cannot watch environments.json; changes need a restart', { error: e });
                    return undefined;
                });
                context.onStarted?.(daemon);
                await (context.until ?? stopSignal());
                watcher?.close();
                await daemon.stop();
                for (const driver of drivers) if (isDisposable(driver)) await driver.dispose().catch((e: unknown) => log.warn('driver dispose failed', { runtime: driver.runtime, error: e }));
                // Runtime processes are spawned through @sigx/ai-agent-node and registered there: none may outlive the daemon.
                for (const child of registeredChildren()) killTreeSync(child);
                return 0;
            }
            case 'env':
                return await envCommand(argv, args.positional[0], args.positional.slice(1), args.flags, {
                    paths,
                    drivers,
                    out,
                    err,
                    secure: { ...(context.platform ? { platform: context.platform } : {}), ...(context.run ? { run: context.run } : {}) },
                    ...(context.login ? { login: context.login } : {}),
                    ...(context.env ? { env: context.env } : {})
                });
            case 'doctor': {
                const report = await runDoctor({ paths, drivers });
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
        const message = e instanceof PairingError ? `pairing failed: ${e.message}` : `agentic-daemon ${args.command ?? ''}: ${(e as Error).message}`;
        err(redact(message, secrets));
        return 1;
    }
}
