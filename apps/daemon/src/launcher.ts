/**
 * `agentic-daemon launcher install | remove | show` (#354): the
 * `agentic-daemon` command itself.
 *
 * The daemon ships as a folder of files (`~/.agentic/daemon`,
 * `%LOCALAPPDATA%\agentic\daemon`) started by a launchd agent, a systemd user
 * unit or a scheduled task — none of which needs a `PATH` entry. Everything a
 * user is told to run does: the Machine page, the Pair page, `README.md` and
 * `docs/runbook.md` all print `agentic-daemon …`. So the install scripts call
 * `launcher install`, which writes a two-line launcher that hard-codes the
 * Node the install resolved (a machine with no Node of its own runs the
 * portable one the installer downloaded) and makes sure a new shell finds it:
 * a symlink into a folder already on `PATH`, else a guarded block in the shell
 * profile, else the user `PATH` on Windows.
 *
 * Planning and editing are split: `launcherPlan` decides everything from
 * injected `platform` / `env` / `home` and touches no disk, so the decisions
 * are tested for all three OSes from any one of them.
 */

import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { runCommand, type CommandRunner } from './credentials.js';

/** The guarded block's fences: an install rewrites what is between them and never appends twice. */
export const PROFILE_BEGIN = '# >>> agentic-daemon >>>';
export const PROFILE_END = '# <<< agentic-daemon <<<';

export interface LauncherContext {
    readonly platform?: NodeJS.Platform;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly home?: string;
    /** The Node the launcher runs the daemon with; default the one running this process. */
    readonly node?: string;
    /** The daemon entry (`bin/agentic-daemon.mjs`); default the script this process was started with. */
    readonly entry?: string;
    /** Where the launcher is written; default `~/.agentic/bin` (`%LOCALAPPDATA%\agentic\bin`). */
    readonly binDir?: string;
    /** `false`: write the launcher but never edit a shell profile or the user `PATH` — the user is told what to add. */
    readonly profile?: boolean;
    /** Runs `powershell` for the Windows user `PATH` (tests). */
    readonly run?: CommandRunner;
}

/** How `agentic-daemon` becomes resolvable in a new shell. */
export type OnPath =
    /** The launcher's own folder is already on `PATH`. */
    | 'bin-dir'
    /** Linked into a folder that is (`~/.local/bin`, `~/bin`). */
    | 'link'
    /** A block added to the shell profile. */
    | 'profile'
    /** Added to the Windows user `PATH`. */
    | 'user-path'
    /** Nothing was changed (`--no-profile`): the user adds the folder. */
    | 'manual';

export interface LauncherPlan {
    readonly platform: NodeJS.Platform;
    readonly node: string;
    readonly entry: string;
    readonly binDir: string;
    /** The launcher file: `agentic-daemon`, or `agentic-daemon.cmd` on Windows. */
    readonly file: string;
    readonly script: string;
    readonly onPath: OnPath;
    /** `onPath: 'link'`: the second name, in a folder already on `PATH`. */
    readonly link?: string;
    /** `onPath: 'profile'`: the file the block goes in, and the block. */
    readonly profileFile?: string;
    readonly profileBlock?: string;
}

const pathOf = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? (win32 as unknown as typeof posix) : posix);

/**
 * The user whose command this is. An injected `env` decides it — every path
 * here is under the home folder, and a test (or an install run with
 * `AGENTIC_DAEMON_HOME` pointing elsewhere) must never reach the real one.
 */
export function launcherHome(context: LauncherContext = {}): string {
    if (context.home) return context.home;
    const platform = context.platform ?? process.platform;
    const env = context.env ?? process.env;
    return (platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir();
}

/** `PATH` as folders, compared the way the OS resolves them: trailing separators and (on Windows) case do not count. */
export function pathEntries(value: string | undefined, platform: NodeJS.Platform): string[] {
    if (!value) return [];
    const separator = platform === 'win32' ? ';' : ':';
    return value
        .split(separator)
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter((entry) => entry.length > 0);
}

export function onPathAlready(dir: string, value: string | undefined, platform: NodeJS.Platform): boolean {
    const normalize = (entry: string): string => {
        const trimmed = entry.replace(/[\\/]+$/, '');
        return platform === 'win32' ? trimmed.toLowerCase().replace(/\//g, '\\') : trimmed;
    };
    const wanted = normalize(dir);
    return pathEntries(value, platform).some((entry) => normalize(entry) === wanted);
}

/** `"…"` for `/bin/sh`: a launcher under a folder with a space, a quote or a `$` still starts. */
export const shQuote = (value: string): string => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

/** The launcher, as the OS runs a script: `exec` on POSIX (no extra process), `%*` and the child's exit code on Windows. */
export function launcherScript(node: string, entry: string, platform: NodeJS.Platform): string {
    if (platform === 'win32') {
        // CRLF and ASCII only: a .cmd is read by cmd.exe under the machine's code page.
        return [
            '@echo off',
            'rem agentic-daemon - written by the daemon installer (see launcher.ts, #354).',
            'rem Re-run the installer to repoint it at another Node or install folder.',
            'setlocal',
            `"${node}" "${entry}" %*`,
            'exit /b %ERRORLEVEL%',
            ''
        ].join('\r\n');
    }
    return [
        '#!/bin/sh',
        '# agentic-daemon — written by the daemon installer (see launcher.ts, #354).',
        '# Re-run the installer to repoint it at another Node or install folder.',
        `exec ${shQuote(node)} ${shQuote(entry)} "$@"`,
        ''
    ].join('\n');
}

/** The login file of the user's shell — where a `PATH` line is read by the next interactive shell. */
export function profileFileFor(shell: string | undefined, home: string): string {
    const name = (shell ?? '').split('/').pop() ?? '';
    if (name === 'zsh') return posix.join(home, '.zshrc');
    if (name === 'bash') return posix.join(home, '.bashrc');
    if (name === 'fish') return posix.join(home, '.config', 'fish', 'config.fish');
    return posix.join(home, '.profile');
}

/** The block a profile gets: fish has its own syntax, and `$HOME` keeps the line portable between machines. */
export function profileBlock(binDir: string, home: string, profileFile: string): string {
    const dir = binDir === home || binDir.startsWith(`${home}/`) ? `$HOME${binDir.slice(home.length)}` : binDir;
    const line = profileFile.endsWith('config.fish') ? `set -gx PATH "${dir}" $PATH` : `export PATH="${dir}:$PATH"`;
    return [PROFILE_BEGIN, line, PROFILE_END].join('\n');
}

/** `block` put into `text`: replacing the block already between the fences, else appended. */
export function withProfileBlock(text: string, block: string): string {
    const begin = text.indexOf(PROFILE_BEGIN);
    const end = text.indexOf(PROFILE_END);
    if (begin !== -1 && end > begin) return `${text.slice(0, begin)}${block}${text.slice(end + PROFILE_END.length)}`;
    const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    return `${base}${text.length === 0 ? '' : '\n'}${block}\n`;
}

/** `text` without the block — and without the blank line the install left in front of it. */
export function withoutProfileBlock(text: string): string {
    const begin = text.indexOf(PROFILE_BEGIN);
    const end = text.indexOf(PROFILE_END);
    if (begin === -1 || end <= begin) return text;
    const before = text.slice(0, begin).replace(/\n{2,}$/, '\n');
    return `${before}${text.slice(end + PROFILE_END.length).replace(/^\n/, '')}`;
}

/**
 * Adds or removes `dir` in the Windows **user** `PATH` (never the machine one:
 * the daemon belongs to the signed-in user). Idempotent — the value is read,
 * filtered and written back, so a second install adds nothing.
 */
export function userPathCommand(dir: string, action: 'add' | 'remove'): { command: string; args: string[] } {
    const literal = `'${dir.replace(/'/g, "''")}'`;
    const script = [
        `$dir = ${literal}`,
        "$value = [Environment]::GetEnvironmentVariable('Path', 'User')",
        "$parts = @(); if ($value) { $parts = @($value.Split(';') | Where-Object { $_.Trim() -ne '' }) }",
        '$kept = @($parts | Where-Object { $_.TrimEnd([char]92) -ne $dir.TrimEnd([char]92) })',
        action === 'add' ? '$next = @($kept + $dir)' : '$next = $kept',
        "if (($next -join ';') -ne ($parts -join ';')) { [Environment]::SetEnvironmentVariable('Path', ($next -join ';'), 'User') }"
    ].join('; ');
    return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] };
}

/** Everything the install will do, decided from the context alone. */
export function launcherPlan(context: LauncherContext = {}): LauncherPlan {
    const platform = context.platform ?? process.platform;
    const env = context.env ?? process.env;
    const home = launcherHome(context);
    const { join } = pathOf(platform);
    const node = context.node ?? process.execPath;
    const entry = context.entry ?? process.argv[1] ?? join(home, '.agentic', 'daemon', 'bin', 'agentic-daemon.mjs');
    const binDir = context.binDir ?? (platform === 'win32' ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'agentic', 'bin') : join(home, '.agentic', 'bin'));
    const file = join(binDir, platform === 'win32' ? 'agentic-daemon.cmd' : 'agentic-daemon');
    const script = launcherScript(node, entry, platform);
    const base = { platform, node, entry, binDir, file, script } as const;

    if (onPathAlready(binDir, env.PATH ?? env.Path, platform)) return { ...base, onPath: 'bin-dir' };
    if (platform === 'win32') return { ...base, onPath: context.profile === false ? 'manual' : 'user-path' };
    // A folder the user already has on PATH is the least invasive home for the command — no profile is touched.
    const linkDir = [join(home, '.local', 'bin'), join(home, 'bin')].find((dir) => onPathAlready(dir, env.PATH, platform));
    if (linkDir) return { ...base, onPath: 'link', link: join(linkDir, 'agentic-daemon') };
    if (context.profile === false) return { ...base, onPath: 'manual' };
    const profileFile = profileFileFor(env.SHELL, home);
    return { ...base, onPath: 'profile', profileFile, profileBlock: profileBlock(binDir, home, profileFile) };
}

export interface LauncherResult {
    readonly plan: LauncherPlan;
    /** What to print: what was written, and what the user still has to do. */
    readonly notes: readonly string[];
    /** The command works in a new terminal, not in the one that ran the install. */
    readonly needsNewShell: boolean;
}

/**
 * `dir` on PATH, as the user would add it by hand. Never `setx` on Windows: it
 * truncates a PATH over 1024 characters, which is most of them.
 */
const exportLine = (plan: LauncherPlan): string =>
    plan.platform === 'win32' ? `[Environment]::SetEnvironmentVariable('Path', "$([Environment]::GetEnvironmentVariable('Path','User'));${plan.binDir}", 'User')` : `export PATH="${plan.binDir}:$PATH"`;

/** Writes the launcher and makes a new shell find it. Re-running it is safe: every step is idempotent. */
export async function installLauncher(context: LauncherContext = {}): Promise<LauncherResult> {
    const plan = launcherPlan(context);
    const notes: string[] = [];
    await mkdir(plan.binDir, { recursive: true });
    await writeFile(plan.file, plan.script, 'utf8');
    if (plan.platform !== 'win32') await chmod(plan.file, 0o755);
    notes.push(`launcher: ${plan.file} → ${plan.node} ${plan.entry}`);

    switch (plan.onPath) {
        case 'bin-dir':
            notes.push(`${plan.binDir} is already on PATH: \`agentic-daemon\` works in a new terminal.`);
            return { plan, notes, needsNewShell: true };
        case 'link': {
            const link = plan.link!;
            // A link the user (or an older install) left behind is replaced; where links are refused, a copy does.
            await rm(link, { force: true });
            try {
                await symlink(plan.file, link);
                notes.push(`linked: ${link}`);
            } catch {
                await writeFile(link, plan.script, 'utf8');
                await chmod(link, 0o755);
                notes.push(`copied: ${link} (this filesystem refuses symlinks)`);
            }
            return { plan, notes, needsNewShell: true };
        }
        case 'profile': {
            const file = plan.profileFile!;
            await mkdir(posix.dirname(file), { recursive: true });
            const before = await readFile(file, 'utf8').catch(() => '');
            const after = withProfileBlock(before, plan.profileBlock!);
            if (after !== before) await writeFile(file, after, 'utf8');
            notes.push(`PATH: added ${plan.binDir} in ${file}${after === before ? ' (already there)' : ''}`);
            notes.push(`This terminal does not have it yet: \`. ${file}\`, or open a new one.`);
            return { plan, notes, needsNewShell: true };
        }
        case 'user-path': {
            const { command, args } = userPathCommand(plan.binDir, 'add');
            const result = await (context.run ?? runCommand)(command, args);
            if (result.code !== 0) {
                notes.push(`could not add ${plan.binDir} to your PATH (${result.stderr.trim() || `${command} exited ${result.code}`}). Add it by hand: ${exportLine(plan)}`);
                return { plan, notes: notes, needsNewShell: true };
            }
            notes.push(`PATH: added ${plan.binDir} to your user PATH. Open a new terminal for it.`);
            return { plan, notes, needsNewShell: true };
        }
        case 'manual':
            notes.push(`${plan.binDir} is not on PATH and nothing was changed. Add it: ${exportLine(plan)}`);
            return { plan, notes, needsNewShell: true };
    }
}

/** Undoes `installLauncher`: the launcher, the link and whatever put its folder on PATH. */
export async function removeLauncher(context: LauncherContext = {}): Promise<{ plan: LauncherPlan; notes: readonly string[] }> {
    // The plan is made as if installing, so the same places are visited; `profile: false` would hide them.
    const plan = launcherPlan({ ...context, profile: true });
    const notes: string[] = [];
    const gone = await lstat(plan.file).then(
        () => true,
        () => false
    );
    await rm(plan.file, { force: true });
    notes.push(gone ? `removed ${plan.file}` : `no launcher at ${plan.file}`);
    // Both POSIX routes are cleaned whichever one this machine took: an earlier install may have chosen the other.
    if (plan.platform !== 'win32') {
        const home = launcherHome(context);
        for (const dir of [posix.join(home, '.local', 'bin'), posix.join(home, 'bin')]) {
            const link = posix.join(dir, 'agentic-daemon');
            if (await lstat(link).then(() => true, () => false)) {
                await rm(link, { force: true });
                notes.push(`removed ${link}`);
            }
        }
        for (const file of new Set([profileFileFor((context.env ?? process.env).SHELL, home), posix.join(home, '.zshrc'), posix.join(home, '.bashrc'), posix.join(home, '.profile'), posix.join(home, '.config', 'fish', 'config.fish')])) {
            const before = await readFile(file, 'utf8').catch(() => undefined);
            if (before === undefined) continue;
            const after = withoutProfileBlock(before);
            if (after === before) continue;
            await writeFile(file, after, 'utf8');
            notes.push(`removed the PATH block from ${file}`);
        }
        return { plan, notes };
    }
    const { command, args } = userPathCommand(plan.binDir, 'remove');
    const result = await (context.run ?? runCommand)(command, args);
    notes.push(result.code === 0 ? `removed ${plan.binDir} from your user PATH` : `could not edit your user PATH (${result.stderr.trim() || `${command} exited ${result.code}`}); remove ${plan.binDir} from it by hand`);
    return { plan, notes };
}

/** `launcher show`: where the command is, what it points at, and whether a shell would find it. */
export function describeLauncher(plan: LauncherPlan, state: { readonly installed: boolean; readonly linked?: boolean }): string {
    const lines = [state.installed ? `launcher: ${plan.file}` : `launcher: not installed (it would be ${plan.file})`, `  runs: ${plan.node} ${plan.entry}`];
    if (!state.installed) lines.push('  install it with `agentic-daemon launcher install` (the daemon installer does this for you)');
    else if (plan.onPath === 'bin-dir') lines.push(`  PATH: ${plan.binDir} is on PATH`);
    else if (state.linked && plan.link) lines.push(`  PATH: linked into ${pathOf(plan.platform).dirname(plan.link)}, which is on PATH`);
    else lines.push(`  PATH: ${plan.binDir} is not on PATH — ${exportLine(plan)}`);
    return lines.join('\n');
}
