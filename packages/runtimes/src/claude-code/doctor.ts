/**
 * `doctor` for Claude Code environments (EXE-07): isolation is one
 * `CLAUDE_CONFIG_DIR` per account, so two environments on one config dir
 * share credentials and settings — reported as an error, never tolerated.
 * Pure: the auth status of every profile comes in from `inspect`.
 *
 * The report travels to the platform as each environment's verdict, and a
 * profile path never leaves the machine (#274): findings name environments
 * and the local command that fixes them, never a config dir. The local
 * `agentic-daemon doctor` adds the paths itself.
 */

import { normalizePath } from '@sigx/ai-agent/coding';
import type { DoctorFinding, DoctorReport, EnvironmentId, EnvironmentInspection, LocalEnvironment } from '@agentic/core';

/**
 * A comparison key for a config dir: separators, `.` / `..` and trailing
 * slashes normalised; case-folded for Windows paths, where `C:\Users\A` and
 * `c:/users/a/` are one directory.
 */
export function configDirKey(dir: string): string {
    const n = normalizePath(dir);
    const key = `${n.root}/${n.segments.join('/')}`;
    return n.root !== '' ? key.toLowerCase() : key;
}

/** The finding codes `claudeCodeDoctor` reports — named so the UI, the Machine verdicts and tests refer to one spelling. */
export const CLAUDE_CODE_DOCTOR_CODES = {
    /** error: two environments resolve to one config dir — one account, one set of settings (EXE-07). */
    sharedConfigDir: 'shared-config-dir',
    /** warn: no `profileDir`; the default config dir is shared with Claude Code run by hand. */
    defaultConfigDir: 'default-config-dir',
    authOk: 'auth-ok',
    authUnknown: 'auth-unknown',
    authMissing: 'auth-missing',
    authExpired: 'auth-expired',
    /** warn: the profile's files could not be read (a permission, say); only this environment is affected. */
    profileUnreadable: 'profile-unreadable'
} as const;

/** The auth finding per `AuthStatus` — one spelling, from the table above. */
const AUTH_CODES: Record<EnvironmentInspection['authStatus'], string> = {
    ok: CLAUDE_CODE_DOCTOR_CODES.authOk,
    unknown: CLAUDE_CODE_DOCTOR_CODES.authUnknown,
    missing: CLAUDE_CODE_DOCTOR_CODES.authMissing,
    expired: CLAUDE_CODE_DOCTOR_CODES.authExpired
};

export interface DoctorInput {
    readonly env: LocalEnvironment;
    /** The config dir the CLI will actually use: `profileDir`, or the default when there is none. */
    readonly configDir: string;
    readonly inspection: EnvironmentInspection;
    /** Reading the profile failed: the error's code (`EACCES`, …), never its message, which names the path. */
    readonly unreadable?: string;
}

export function claudeCodeDoctor(inputs: readonly DoctorInput[]): DoctorReport {
    const findings: DoctorFinding[] = [];

    const byDir = new Map<string, { isDefault: boolean; ids: EnvironmentId[]; names: string[] }>();
    for (const { env, configDir } of inputs) {
        const key = configDirKey(configDir);
        const group = byDir.get(key) ?? { isDefault: env.profileDir === undefined, ids: [], names: [] };
        group.ids.push(env.id);
        group.names.push(env.name);
        byDir.set(key, group);
    }
    for (const group of byDir.values()) {
        if (group.ids.length < 2) continue;
        findings.push({
            level: 'error',
            code: CLAUDE_CODE_DOCTOR_CODES.sharedConfigDir,
            message: `Environments ${group.names.map((n) => `"${n}"`).join(', ')} share ${group.isDefault ? 'the default Claude Code config dir' : 'one Claude Code profile directory'}: they would use one account and one set of settings. Give each its own profile (\`agentic-daemon env add\` allocates one).`,
            environmentIds: group.ids
        });
    }

    for (const { env, inspection, unreadable } of inputs) {
        if (env.profileDir === undefined) {
            findings.push({
                level: 'warn',
                code: CLAUDE_CODE_DOCTOR_CODES.defaultConfigDir,
                message: `Environment "${env.name}" has no profile of its own and uses the default Claude Code config dir; it is not isolated from Claude Code run by hand on this machine.`,
                environmentIds: [env.id]
            });
        }
        const login = `\`agentic-daemon env login ${env.id}\``;
        if (unreadable !== undefined) {
            findings.push({
                level: 'warn',
                code: CLAUDE_CODE_DOCTOR_CODES.profileUnreadable,
                message: `Environment "${env.name}": its profile could not be read (${unreadable}). Run \`agentic-daemon doctor\` on the machine for the path.`,
                environmentIds: [env.id]
            });
            continue;
        }
        const who = inspection.identity === undefined ? '' : ` (${inspection.identity})`;
        const auth = `Environment "${env.name}": auth ${inspection.authStatus}${who}.`;
        const code = AUTH_CODES[inspection.authStatus];
        if (inspection.authStatus === 'ok') findings.push({ level: 'info', code, message: auth, environmentIds: [env.id] });
        else if (inspection.authStatus === 'unknown') findings.push({ level: 'warn', code, message: `${auth} Check it on the machine with ${login}.`, environmentIds: [env.id] });
        else findings.push({ level: 'warn', code, message: `${auth} Sign in on the machine with ${login}.`, environmentIds: [env.id] });
    }

    return { ok: !findings.some((f) => f.level === 'error'), findings };
}
