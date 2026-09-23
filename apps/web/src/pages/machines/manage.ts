/**
 * Setting a machine up from its page (#239): the pure half of adding,
 * changing and removing environments through `Machine.putEnvironment` /
 * `removeEnvironment` (#237), the commands the page hands the user for the
 * steps that stay on the machine — signing an account in (`agentic-daemon
 * env login`, #235), and turning web management on with `policy allow-root`
 * (#238) on a daemon that predates web-set folders (#355; `./policy.ts` is
 * the folders card's half) — the long form for a daemon installed before
 * the installer wrote a launcher (#354) — and how a refusal reads.
 *
 * The daemon's policy is what it enforces, whoever set it: the check here
 * only saves a round trip for a folder that is plainly outside
 * `allowedRoots`; the daemon resolves links and decides.
 */
import type { EnvError, EnvErrorCode, EnvironmentDescriptor, EnvironmentId, EnvironmentInput, HarnessReport, HostOs, MachinePolicy } from '@agentic/core';

/** What the environment dialog edits. `id` is empty for a new environment (the daemon mints one). */
export interface EnvironmentDraft {
    id: string;
    name: string;
    runtime: string;
    /** One folder per line, as typed. */
    roots: string;
    concurrency: number | null;
    accountLabel: string;
    /** Sessions here may run in a mode that asks about nothing (#450, #482): turning it on needs elevation. */
    allowBypass: boolean;
    /** The environment had it when the dialog opened: turning it off is sent as an explicit `false`. */
    hadBypass?: boolean;
}

export type DraftField = 'name' | 'runtime' | 'roots' | 'concurrency';
export type DraftErrors = Partial<Record<DraftField, string>>;

/** A refusal the page shows: the daemon's own `EnvError`, or why the platform never sent the request. */
export interface EnvFailure {
    readonly code: EnvErrorCode | 'machine-offline' | 'revoked' | 'forbidden' | 'not-found' | 'internal' | 'policy-locked' | 'protected';
    readonly message: string;
}

/**
 * Where web management stands on a machine: `unknown` when its daemon reports no policy (it predates #238, or never
 * said hello); `locked` when it is off AND locked on the machine (#355) — nothing the web can turn on. A locked policy
 * that is on still reads `on`: environments inside its folders are managed as usual, only the folders are read-only.
 */
export type PolicyState = 'on' | 'off' | 'unknown' | 'locked';

export function policyState(policy: MachinePolicy | undefined): PolicyState {
    if (!policy) return 'unknown';
    if (policy.webManaged) return 'on';
    return policy.locked ? 'locked' : 'off';
}

/** A shell argument as the user pastes it: quoted when it holds a space or a quote. */
export function shellArg(value: string): string {
    return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Signs an account in on the machine, in the environment's own profile directory (#235). */
export const loginCommand = (environmentId: string): string => `agentic-daemon env login ${shellArg(environmentId)}`;

/** Turns web management on for one folder, on the machine (#238). */
export const allowRootCommand = (folder?: string): string => `agentic-daemon policy allow-root ${folder ? shellArg(folder) : '<folder>'}`;

/**
 * Where the one-line installer puts the daemon on each OS
 * (`apps/web/public/install.sh`, `install.ps1`), spelled for the shell the
 * page's own install line uses: PowerShell on Windows, where `%LOCALAPPDATA%`
 * would not expand.
 */
export const daemonHome: Record<HostOs, string> = {
    windows: '$env:LOCALAPPDATA\\agentic\\daemon',
    darwin: '~/.agentic/daemon',
    linux: '~/.agentic/daemon'
};

/**
 * The same command without the `agentic-daemon` launcher: what to run when the
 * command is not found, which is every machine installed before #354. The
 * Windows form is quoted whatever it holds — `"$env:…"` expands in PowerShell,
 * and `&` in front is not needed while the line starts with a bare `node`.
 */
export function fallbackCommand(command: string, os: HostOs): string {
    const args = command.startsWith('agentic-daemon ') ? command.slice('agentic-daemon '.length) : command;
    if (os === 'windows') return `node "${daemonHome.windows}\\bin\\agentic-daemon.mjs" ${args}`;
    return `node ${shellArg(`${daemonHome[os]}/bin/agentic-daemon.mjs`)} ${args}`;
}

/** An account that cannot run work until someone signs it in on the machine. */
export const needsLogin = (env: EnvironmentDescriptor): boolean => env.account.authStatus === 'missing' || env.account.authStatus === 'expired';

/**
 * The runtimes a machine can host: what its daemon's drivers report, else what its environments already run — plus
 * every runtime whose harness the daemon reports installed and working (#527). The daemon reports capabilities only
 * for runtimes an environment already runs on, so without the harnesses a runtime could never get its first one.
 */
export function runtimesOf(capabilities: readonly { readonly runtime: string }[], environments: readonly EnvironmentDescriptor[], harnesses: readonly HarnessReport[] = []): string[] {
    const out = new Set<string>();
    for (const c of capabilities) out.add(c.runtime);
    if (out.size === 0) for (const e of environments) out.add(e.runtime);
    for (const h of harnesses) if (h.status === 'ready' && h.installed) out.add(h.runtime);
    return [...out];
}

export function emptyDraft(runtimes: readonly string[]): EnvironmentDraft {
    return { id: '', name: '', runtime: runtimes[0] ?? '', roots: '', concurrency: null, accountLabel: '', allowBypass: false, hadBypass: false };
}

/** An environment as the dialog edits it; the account label is kept only when it differs from the name (the daemon's default). */
export function draftOf(env: EnvironmentDescriptor): EnvironmentDraft {
    return {
        id: env.id,
        name: env.name,
        runtime: env.runtime,
        roots: env.cwdRoots.join('\n'),
        concurrency: env.concurrency.max,
        accountLabel: env.account.label === env.name ? '' : env.account.label,
        allowBypass: env.allowBypassPermissions === true,
        hadBypass: env.allowBypassPermissions === true
    };
}

/** The typed folders: one per line, trimmed, blanks and repeats dropped. */
export function rootsOf(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

/** Add one folder to the typed list, unless it is already there. */
export function withRoot(text: string, folder: string): string {
    const roots = rootsOf(text);
    return roots.includes(folder) ? roots.join('\n') : [...roots, folder].join('\n');
}

/** `C:\Dev` / `/home/me/src` — a UNC or device path (`\\server\share`, `\\?\…`) is not one. */
export function isAbsoluteRoot(path: string, os: HostOs): boolean {
    if (os === 'windows') return /^[A-Za-z]:[\\/]/.test(path);
    return path.startsWith('/');
}

/** Spelling only: separators unified, a trailing separator dropped, case folded on Windows. Links are the daemon's to resolve. */
function norm(path: string, os: HostOs): string {
    if (os === 'windows') return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    return path.replace(/\/+$/, '');
}

/** `path` is `root` or lies under it, segment-wise (`C:\Devtools` is not under `C:\Dev`). */
export function isWithin(path: string, root: string, os: HostOs): boolean {
    const p = norm(path, os);
    const r = norm(root, os);
    const sep = os === 'windows' ? '\\' : '/';
    return p === r || p.startsWith(r + sep);
}

export interface DraftContext {
    readonly policy: MachinePolicy | undefined;
    readonly os: HostOs;
    readonly runtimes: readonly string[];
    /** The other environments' names on this machine: a second "work" would be ambiguous in every picker. */
    readonly takenNames: readonly string[];
}

/** What stops the dialog from sending: the same rules the daemon applies, stated before the round trip. */
export function validateDraft(draft: EnvironmentDraft, context: DraftContext): DraftErrors {
    const errors: DraftErrors = {};
    const name = draft.name.trim();
    if (!name) errors.name = 'A name is required.';
    else if (context.takenNames.some((n) => n.toLowerCase() === name.toLowerCase())) errors.name = `This machine already has an environment named ${name}.`;
    if (!draft.runtime) errors.runtime = 'Pick a runtime.';
    // A new environment only: an existing one keeps its runtime, and the daemon has the last word on it.
    else if (!draft.id && context.runtimes.length && !context.runtimes.includes(draft.runtime)) errors.runtime = `The daemon on this machine has no ${draft.runtime} driver.`;
    const roots = rootsOf(draft.roots);
    const allowed = context.policy?.allowedRoots ?? [];
    if (roots.length === 0) errors.roots = 'Add at least one folder agents may work in.';
    else {
        const relative = roots.find((r) => !isAbsoluteRoot(r, context.os));
        const outside = roots.find((r) => allowed.length > 0 && !allowed.some((a) => isWithin(r, a, context.os)));
        if (relative) errors.roots = `${relative} is not a full path on this machine.`;
        else if (outside) errors.roots = `${outside} is outside the folders this machine allows (${allowed.join(', ')}).`;
    }
    if (draft.concurrency !== null && (!Number.isInteger(draft.concurrency) || draft.concurrency < 1)) errors.concurrency = 'At least one session at a time.';
    return errors;
}

/**
 * The request `putEnvironment` sends; an unset concurrency or label leaves the daemon's (or the environment's own)
 * value. `allowBypassPermissions` goes only when it is on, or to turn it off where it was on (the daemon keeps the
 * flag when the field is absent, #479).
 */
export function inputOf(draft: EnvironmentDraft): EnvironmentInput {
    const label = draft.accountLabel.trim();
    return {
        ...(draft.id ? { id: draft.id as EnvironmentId } : {}),
        name: draft.name.trim(),
        runtime: draft.runtime,
        cwdRoots: rootsOf(draft.roots),
        ...(draft.concurrency !== null ? { concurrency: draft.concurrency } : {}),
        ...(label ? { accountLabel: label } : {}),
        ...(draft.allowBypass ? { allowBypassPermissions: true } : draft.hadBypass ? { allowBypassPermissions: false } : {})
    };
}

/** Whether a save turns `bypassPermissions` on where it was off: the one environment change that needs elevation (#480). */
export const turnsBypassOn = (input: EnvironmentInput, environments: readonly EnvironmentDescriptor[]): boolean =>
    input.allowBypassPermissions === true && !(input.id && environments.some((e) => e.id === input.id && e.allowBypassPermissions === true));

/** The dialog field a refusal belongs under, or `null` for the dialog's own error line. */
export function failureField(failure: EnvFailure): DraftField | null {
    switch (failure.code) {
        case 'outside-allowed-roots':
            return 'roots';
        case 'unknown-runtime':
            return 'runtime';
        default:
            return null;
    }
}

/** A refusal as a sentence. The daemon's message follows where it adds something (which folder, which runtime). */
export function failureText(failure: EnvFailure): string {
    const detail = failure.message ? ` ${failure.message}` : '';
    switch (failure.code) {
        case 'policy-disabled':
            return 'This machine does not let the web manage its environments. Turn it on there first.';
        case 'outside-allowed-roots':
            return `A folder is outside what this machine allows.${detail}`;
        case 'unknown-runtime':
            return `The daemon has no driver for that runtime.${detail}`;
        case 'in-use':
            return 'Work is running or queued in this environment. Let it finish or cancel it, then remove the environment.';
        case 'unknown-environment':
        case 'not-found':
            return 'The machine no longer has this environment.';
        case 'invalid':
            return `The daemon refused the environment.${detail}`;
        case 'io':
            return `The daemon could not write its environments file.${detail}`;
        case 'timeout':
            return "The machine didn't answer in time. It may still apply the change — check again in a moment.";
        case 'machine-offline':
            return 'The machine is offline. Environments can be changed while its daemon is connected.';
        case 'revoked':
            return 'This machine is revoked.';
        case 'forbidden':
            return 'Only the workspace owner can change a machine.';
        case 'policy-locked':
            return 'The policy is locked on the machine: run agentic-daemon policy unlock there first.';
        case 'protected':
            return `A folder is inside the daemon's own folders and cannot be used.${detail}`;
        default:
            return failure.message || 'Something went wrong.';
    }
}

/** A thrown actor call as a refusal: the Machine's status codes (#237) — 400, 403, 404, 409 `in-use`, 503 `machine-offline`. */
export function callFailure(e: unknown): EnvFailure {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 503) return { code: 'machine-offline', message };
    if (status === 409) return { code: 'in-use', message };
    if (status === 404) return { code: 'not-found', message };
    if (status === 403) return { code: /revoked/.test(message) ? 'revoked' : 'forbidden', message };
    if (status === 400) return { code: 'invalid', message: message.replace(/^machine: invalid environment: /, '') };
    return { code: 'internal', message };
}

/** The daemon's answer as a refusal (`envResult.error`). */
export const answerFailure = (error: EnvError): EnvFailure => ({ code: error.code, message: error.message });
