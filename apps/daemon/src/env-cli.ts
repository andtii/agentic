/**
 * `agentic-daemon env add --name <name> --root <dir>… [--runtime claude-code] [--id <id>]
 *                         [--concurrency <n>] [--account <label>] [--profile-dir <dir>] [--replace]`
 * `agentic-daemon env list`
 * `agentic-daemon env rm <id>`
 * `agentic-daemon env login <id> [--claude <path to the claude CLI>]`
 *
 * Thin over `env-store.ts` (#235). A running daemon watches the file, so none
 * of these needs a restart. `login` runs the runtime's own sign-in with the
 * environment's profile (`CLAUDE_CONFIG_DIR`) and nothing inherited that could
 * pick another account — the same rule the driver opens sessions under.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SecureWriteOptions } from './credentials.js';
import type { DaemonDriver } from './daemon.js';
import { deleteEnvironment, EnvironmentStoreError, putEnvironment, readEnvironmentsForEdit } from './env-store.js';
import type { DaemonPaths } from './paths.js';

/** Runs an interactive sign-in attached to this terminal; resolves to its exit code. */
export type LoginRunner = (command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<number | null>;

export const runLogin: LoginRunner = (command, args, env) =>
    new Promise((done, reject) => {
        // On Windows the CLI is usually a `.cmd` shim, which only a shell can start; one command string, so nothing is re-split.
        const child = process.platform === 'win32' ? spawn(`"${command}" ${args.join(' ')}`, { shell: true, stdio: 'inherit', env }) : spawn(command, [...args], { stdio: 'inherit', env });
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

export const ENV_USAGE = `  agentic-daemon env add --name <name> --root <dir> [--root <dir>…] [--runtime claude-code] [--id <id>]
                         [--concurrency <n>] [--account <label>] [--profile-dir <dir>]
                         [--replace]   (with --id: change an environment; its profile is kept)
  agentic-daemon env list
  agentic-daemon env rm <id>
  agentic-daemon env login <id> [--claude <path>]`;

/** The sign-in environment: the parent's, minus what could select another account, plus this profile. */
export function loginEnv(parent: Readonly<Record<string, string | undefined>>, profileDir: string | undefined): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(parent)) if (!/^ANTHROPIC_/i.test(key) && !/^CLAUDE_CONFIG_DIR$/i.test(key)) env[key] = value;
    if (profileDir !== undefined) env.CLAUDE_CONFIG_DIR = profileDir;
    return env;
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
                        ...(profileDir ? { profileDir: resolve(profileDir) } : {})
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
                c.out(`${flags.replace === true ? 'saved' : 'added'} environment ${environment.id} (${environment.name}, ${environment.runtime}); profile ${environment.profileDir}`);
                if (environment.runtime === 'claude-code') c.out(`sign it in with: agentic-daemon env login ${environment.id}`);
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
                if (environment.runtime !== 'claude-code') {
                    c.err(`env login knows how to sign in claude-code environments; "${id}" runs ${environment.runtime}`);
                    return 1;
                }
                const code = await (c.login ?? runLogin)(text(flags.claude) ?? 'claude', ['/login'], loginEnv(c.env ?? process.env, environment.profileDir));
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
