/**
 * `agentic-daemon env add --name <name> --root <dir>… [--runtime claude-code|copilot-cli|codex-cli] [--id <id>]
 *                         [--concurrency <n>] [--account <label>] [--profile-dir <dir>] [--allow-bypass] [--replace]`
 * `agentic-daemon env list`
 * `agentic-daemon env rm <id>`
 * `agentic-daemon env login <id> [--cli <path to the runtime's CLI>]`
 *
 * Thin over `env-store.ts` (#235). A running daemon watches the file, so none
 * of these needs a restart. `login` runs the runtime's own sign-in with the
 * environment's profile (`CLAUDE_CONFIG_DIR`, `COPILOT_HOME`, `CODEX_HOME`) and nothing
 * inherited that could pick another account — the same rule the driver opens
 * sessions under (#321). Claude Code and Codex sign in with the executable of
 * the runtime's installed harness (#369) — the one sessions run — and `env add`
 * says how to install a harness the runtime lacks.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { codexAccountEnv } from '@agentic/runtimes/codex-cli';
import { copilotAccountEnv } from '@agentic/runtimes/copilot-cli';
import type { SecureWriteOptions } from './credentials.js';
import type { DaemonDriver, DaemonLoginPort } from './daemon.js';
import { deleteEnvironment, EnvironmentStoreError, putEnvironment, readEnvironmentsForEdit } from './env-store.js';
import type { HarnessLocator } from './harness.js';
import { parseClaudeLogin, parseCodexLogin, parseCopilotLogin, spawnLoginRelay, type LoginParser } from './login-relay.js';
import type { DaemonPaths } from './paths.js';

/** Runs an interactive sign-in attached to this terminal; resolves to its exit code. */
export type LoginRunner = (command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<number | null>;

/** One argument on a `cmd.exe` line: quoted when it has spaces or quotes (a launcher under `C:\Program Files`, say). */
export const quoteArg = (arg: string): string => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

export const runLogin: LoginRunner = (command, args, env) =>
    new Promise((done, reject) => {
        // On Windows the CLI is usually a `.cmd` shim, which only a shell can start; one command string, so nothing is re-split.
        const child = process.platform === 'win32' ? spawn(`"${command}" ${args.map(quoteArg).join(' ')}`, { shell: true, stdio: 'inherit', env }) : spawn(command, [...args], { stdio: 'inherit', env });
        child.on('error', reject);
        child.on('close', done);
    });

export interface EnvCommandContext {
    readonly paths: DaemonPaths;
    readonly drivers: readonly DaemonDriver[];
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    readonly secure: SecureWriteOptions;
    readonly login?: LoginRunner;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Where each runtime's harness is (#369): `login` runs its executable, `add` warns when there is none. */
    readonly harnesses?: HarnessLocator;
}

/** Every value of a repeatable flag: `--root a --root=b`. */
export function flagValues(argv: readonly string[], flag: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === `--${flag}` && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out.push(argv[++i]!);
        else if (arg.startsWith(`--${flag}=`)) out.push(arg.slice(flag.length + 3));
    }
    return out;
}

export const ENV_USAGE = `  agentic-daemon env add --name <name> --root <dir> [--root <dir>…] [--runtime claude-code|copilot-cli|codex-cli] [--id <id>]
                         [--concurrency <n>] [--account <label>] [--profile-dir <dir>]
                         [--allow-bypass]   (lets a chat member run this environment in bypassPermissions: every tool unasked)
                        [--replace]   (with --id: change an environment; its profile is kept)
  agentic-daemon env list
  agentic-daemon env rm <id>
  agentic-daemon env login <id> [--cli <path>]`;

/** The Claude Code sign-in environment: the parent's, minus what could select another account, plus this profile. */
export function loginEnv(parent: Readonly<Record<string, string | undefined>>, profileDir: string | undefined): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(parent)) if (!/^ANTHROPIC_/i.test(key) && !/^CLAUDE_CONFIG_DIR$/i.test(key)) env[key] = value;
    if (profileDir !== undefined) env.CLAUDE_CONFIG_DIR = profileDir;
    return env;
}

/** `parent` with a runtime's account variables applied: `undefined` removes a key. */
function withAccount(parent: Readonly<Record<string, string | undefined>>, account: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...parent };
    for (const [key, value] of Object.entries(account)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    return env;
}

/** The `@openai/codex` launcher this daemon ships, run with this Node; `undefined` when it is not installed. */
function codexLauncher(): string | undefined {
    try {
        return createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    } catch {
        return undefined;
    }
}

/** How a runtime signs an environment in: its CLI, the sign-in command, and the environment it runs under. */
export interface RuntimeSignIn {
    /** The CLI (on `PATH`, or the one this daemon ships); `--cli` names another. */
    readonly command: string;
    /** What goes before the sign-in arguments when `command` is the default (a launcher script). */
    readonly prefix?: readonly string[];
    readonly args: readonly string[];
    /** The runtime's harness executable is its CLI (#369): with one installed, `login` runs it instead of `command`. */
    readonly harness?: true;
    env(parent: Readonly<Record<string, string | undefined>>, profileDir: string | undefined): Record<string, string | undefined>;
    /**
     * The same CLI's sign-in relayed to the web (#484, from the #483 spike): the arguments that make it print what the
     * person must do instead of opening a browser on the machine, and the parser that reads it. Absent → terminal only.
     */
    readonly relay?: { readonly args: readonly string[]; readonly parse: LoginParser };
}

/** The runtimes `env login` can sign in, by runtime id. */
export const SIGN_INS: Readonly<Record<string, RuntimeSignIn>> = {
    'claude-code': { command: 'claude', args: ['/login'], env: loginEnv, harness: true, relay: { args: ['auth', 'login', '--claudeai'], parse: parseClaudeLogin } },
    'copilot-cli': { command: 'copilot', args: ['login'], env: (parent, profileDir) => withAccount(parent, copilotAccountEnv(profileDir === undefined ? {} : { profileDir }, parent)), relay: { args: ['login', '--device-code'], parse: parseCopilotLogin } },
    'codex-cli': {
        ...(() => {
            const launcher = codexLauncher();
            return launcher ? { command: process.execPath, prefix: [launcher] } : { command: 'codex' };
        })(),
        args: ['login'],
        env: (parent, profileDir) => withAccount(parent, codexAccountEnv(profileDir === undefined ? {} : { profileDir }, parent)),
        harness: true,
        relay: { args: ['login', '--device-auth'], parse: parseCodexLogin }
    }
};

/** Whether `command` is on `PATH` as an executable (`.exe` / `.cmd` / … on Windows); an absolute path is checked as is. */
export function onPath(command: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): boolean {
    const win = platform === 'win32';
    const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    const candidates = (base: string): string[] => (win && !/\.[A-Za-z0-9]+$/.test(base) ? exts.map((x) => base + x.toLowerCase()) : [base]);
    if (isAbsolute(command)) return candidates(command).some((c) => existsSync(c));
    const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
    return dirs.some((dir) => candidates(join(dir, command)).some((c) => existsSync(c)));
}

export interface LoginPortContext {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly harnesses?: HarnessLocator;
    readonly platform?: NodeJS.Platform;
    /** How a relay is started; the real spawn unless a test binds a fake. */
    readonly spawn?: typeof spawnLoginRelay;
}

/**
 * The daemon's `login` port (#484): which runtimes relay on this machine, and a relay per environment — the runtime's
 * CLI resolved exactly as `env login` resolves it (the harness executable, else the shipped launcher, else `PATH`),
 * the relay arguments, the profile's environment.
 */
export function loginPort(c: LoginPortContext): DaemonLoginPort {
    const platform = c.platform ?? process.platform;
    const cliOf = (runtime: string): { readonly command: string; readonly args: readonly string[]; readonly signIn: RuntimeSignIn } | undefined => {
        const signIn = SIGN_INS[runtime];
        if (!signIn?.relay) return undefined;
        const harness = signIn.harness ? c.harnesses?.locate(runtime) : undefined;
        if (harness) return { command: harness.binary, args: signIn.relay.args, signIn };
        if (signIn.prefix) return { command: signIn.command, args: [...signIn.prefix, ...signIn.relay.args], signIn };
        return onPath(signIn.command, c.env, platform) ? { command: signIn.command, args: signIn.relay.args, signIn } : undefined;
    };
    return {
        relays: (runtime) => cliOf(runtime) !== undefined,
        start(environment) {
            const r = cliOf(environment.runtime);
            if (!r) return null;
            return (c.spawn ?? spawnLoginRelay)({ command: r.command, args: r.args, env: r.signIn.env(c.env, environment.profileDir), parse: r.signIn.relay!.parse, platform });
        }
    };
}

const text = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export async function envCommand(argv: readonly string[], sub: string | undefined, positional: readonly string[], flags: Readonly<Record<string, string | true>>, c: EnvCommandContext): Promise<number> {
    try {
        switch (sub) {
            case 'add': {
                const name = text(flags.name);
                const roots = flagValues(argv, 'root');
                if (!name || roots.length === 0) {
                    c.err(`env add needs --name and at least one --root\n\n${ENV_USAGE}`);
                    return 2;
                }
                const runtime = text(flags.runtime) ?? 'claude-code';
                if (!c.drivers.some((d) => d.runtime === runtime)) {
                    c.err(`this daemon has no driver for runtime "${runtime}" (it has: ${c.drivers.map((d) => d.runtime).join(', ') || 'none'})`);
                    return 1;
                }
                // A flag given without its value parses as `true`: say so, rather than let `Number(true)` make it 1.
                for (const flag of ['id', 'runtime', 'concurrency', 'account', 'profile-dir']) {
                    if (flags[flag] === true) {
                        c.err(`--${flag} needs a value

${ENV_USAGE}`);
                        return 2;
                    }
                }
                const concurrency = flags.concurrency === undefined ? undefined : Number(flags.concurrency);
                const id = text(flags.id);
                const account = text(flags.account);
                const profileDir = text(flags['profile-dir']);
                const environment = await putEnvironment(
                    c.paths,
                    {
                        ...(id ? { id } : {}),
                        name,
                        runtime,
                        cwdRoots: roots.map((r) => resolve(r)),
                        ...(concurrency === undefined ? {} : { concurrency }),
                        ...(account ? { accountLabel: account } : {}),
                        ...(profileDir ? { profileDir: resolve(profileDir) } : {}),
                        ...(flags['allow-bypass'] === true ? { allowBypassPermissions: true } : {})
                    },
                    { ...c.secure, ...(flags.replace === true ? { replace: true } : {}) }
                );
                for (const root of environment.cwdRoots) {
                    const ok = await stat(root).then(
                        (s) => s.isDirectory(),
                        () => false
                    );
                    if (!ok) c.err(`warning: working root ${root} is not a directory (yet)`);
                }
                c.out(`${flags.replace === true ? 'saved' : 'added'} environment ${environment.id} (${environment.name}, ${environment.runtime}); profile ${environment.profileDir ?? "(the runtime default)"}`);
                if (c.harnesses && !c.harnesses.locate(environment.runtime)) c.err(`the ${environment.runtime} harness is not installed: sessions on this environment are refused until you run \`agentic-daemon harness install ${environment.runtime}\``);
                if (SIGN_INS[environment.runtime]) c.out(`sign it in with: agentic-daemon env login ${environment.id}`);
                return 0;
            }
            case 'list': {
                const environments = await readEnvironmentsForEdit(c.paths.environmentsFile);
                if (environments.length === 0) c.out(`no environments — add one with \`agentic-daemon env add --name <name> --root <dir>\``);
                for (const e of environments) c.out(`${e.id}\t${e.name}\t${e.runtime}\tconcurrency ${e.concurrency}\troots ${e.cwdRoots.join(', ')}\tprofile ${e.profileDir ?? '(default)'}`);
                return 0;
            }
            case 'rm': {
                const id = positional[0];
                if (!id) {
                    c.err(`env rm needs an environment id\n\n${ENV_USAGE}`);
                    return 2;
                }
                const removed = await deleteEnvironment(c.paths, id, c.secure);
                c.out(`removed environment ${removed.id}${removed.profileDir ? `; its profile (sign-in) is still at ${removed.profileDir}` : ''}`);
                return 0;
            }
            case 'login': {
                const id = positional[0];
                if (!id) {
                    c.err(`env login needs an environment id\n\n${ENV_USAGE}`);
                    return 2;
                }
                const environment = (await readEnvironmentsForEdit(c.paths.environmentsFile)).find((e) => e.id === id);
                if (!environment) {
                    c.err(`no environment "${id}"`);
                    return 1;
                }
                const signIn = SIGN_INS[environment.runtime];
                if (!signIn) {
                    c.err(`env login knows how to sign in ${Object.keys(SIGN_INS).join(', ')} environments; "${id}" runs ${environment.runtime}`);
                    return 1;
                }
                // `--claude` is the flag's first name, kept for Claude Code.
                const cli = text(flags.cli) ?? (environment.runtime === 'claude-code' ? text(flags.claude) : undefined);
                const harness = signIn.harness ? c.harnesses?.locate(environment.runtime) : undefined;
                const [command, args] = cli !== undefined ? [cli, signIn.args] : harness ? [harness.binary, signIn.args] : [signIn.command, [...(signIn.prefix ?? []), ...signIn.args]];
                const code = await (c.login ?? runLogin)(command, args, signIn.env(c.env ?? process.env, environment.profileDir));
                if (code !== 0) {
                    c.err(`the sign-in exited ${code}`);
                    return 1;
                }
                c.out(`signed in; a running daemon reports it within half a minute`);
                return 0;
            }
            default:
                c.err(`${sub ? `unknown env command "${sub}"` : 'env needs a command'}\n\n${ENV_USAGE}`);
                return 2;
        }
    } catch (e) {
        if (!(e instanceof EnvironmentStoreError)) throw e;
        c.err(e.message);
        return 1;
    }
}
