/**
 * `doctor` for Claude Code environments (EXE-07): isolation is one
 * `CLAUDE_CONFIG_DIR` per account, so two environments on one config dir
 * share credentials and settings — reported as an error, never tolerated.
 * Pure: the auth status of every profile comes in from `inspect`.
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
    authExpired: 'auth-expired'
} as const;

export interface DoctorInput {
    readonly env: LocalEnvironment;
    /** The config dir the CLI will actually use: `profileDir`, or the default when there is none. */
    readonly configDir: string;
    readonly inspection: EnvironmentInspection;
}

export function claudeCodeDoctor(inputs: readonly DoctorInput[]): DoctorReport {
    const findings: DoctorFinding[] = [];

    const byDir = new Map<string, { dir: string; ids: EnvironmentId[]; names: string[] }>();
    for (const { env, configDir } of inputs) {
        const key = configDirKey(configDir);
        const group = byDir.get(key) ?? { dir: configDir, ids: [], names: [] };
        group.ids.push(env.id);
        group.names.push(env.name);
        byDir.set(key, group);
    }
    for (const group of byDir.values()) {
        if (group.ids.length < 2) continue;
        findings.push({
            level: 'error',
            code: CLAUDE_CODE_DOCTOR_CODES.sharedConfigDir,
            message: `Environments ${group.names.map((n) => `"${n}"`).join(', ')} share the Claude Code config dir ${group.dir}: they would use one account and one set of settings. Give each its own profileDir.`,
            environmentIds: group.ids
        });
    }

    for (const { env, configDir, inspection } of inputs) {
        if (env.profileDir === undefined) {
            findings.push({
                level: 'warn',
                code: CLAUDE_CODE_DOCTOR_CODES.defaultConfigDir,
                message: `Environment "${env.name}" has no profileDir and uses the default Claude Code config dir ${configDir}; it is not isolated from Claude Code run by hand on this machine.`,
                environmentIds: [env.id]
            });
        }
        const who = inspection.identity === undefined ? '' : ` (${inspection.identity})`;
        const auth = `Environment "${env.name}" at ${configDir}: auth ${inspection.authStatus}${who}.`;
        if (inspection.authStatus === 'ok') findings.push({ level: 'info', code: CLAUDE_CODE_DOCTOR_CODES.authOk, message: auth, environmentIds: [env.id] });
        else if (inspection.authStatus === 'unknown') findings.push({ level: 'warn', code: CLAUDE_CODE_DOCTOR_CODES.authUnknown, message: `${auth} Run \`claude\` with CLAUDE_CONFIG_DIR=${configDir} to check.`, environmentIds: [env.id] });
        else findings.push({ level: 'warn', code: `auth-${inspection.authStatus}`, message: `${auth} Sign in with CLAUDE_CONFIG_DIR=${configDir} claude /login.`, environmentIds: [env.id] });
    }

    return { ok: !findings.some((f) => f.level === 'error'), findings };
}
