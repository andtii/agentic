/**
 * `doctor` for Copilot CLI environments (EXE-07). Isolation is one `COPILOT_HOME` per account (plus the
 * GitHub CLI config inside it), so two environments on one home share a login — an error. Pure: each
 * environment's sign-in comes in from `inspect`. Findings name environments, never a path (#274).
 */

import type { DoctorFinding, DoctorReport, EnvironmentId, EnvironmentInspection, LocalEnvironment } from '@agentic/core';
import { configDirKey } from '../claude-code/doctor.js';

export const COPILOT_CLI_DOCTOR_CODES = {
    /** error: two environments resolve to one `COPILOT_HOME` — one account (EXE-07). */
    sharedHome: 'shared-home',
    /** warn: no `profileDir`; `~/.copilot` and the user's own GitHub CLI login are shared with Copilot run by hand. */
    defaultHome: 'default-home',
    authOk: 'auth-ok',
    authUnknown: 'auth-unknown',
    authMissing: 'auth-missing',
    authExpired: 'auth-expired',
    /** warn: a profile with no Copilot login of its own, running on the machine's GitHub CLI (or a token variable) login. */
    sharedLogin: 'shared-login',
    /** error: the Copilot runtime could not be started for this environment (not installed, or too old a Node). */
    runtimeUnavailable: 'runtime-unavailable'
} as const;

const AUTH_CODES: Record<EnvironmentInspection['authStatus'], string> = {
    ok: COPILOT_CLI_DOCTOR_CODES.authOk,
    unknown: COPILOT_CLI_DOCTOR_CODES.authUnknown,
    missing: COPILOT_CLI_DOCTOR_CODES.authMissing,
    expired: COPILOT_CLI_DOCTOR_CODES.authExpired
};

export interface CopilotDoctorInput {
    readonly env: LocalEnvironment;
    /** The `COPILOT_HOME` the runtime will use: `profileDir`, or the default. */
    readonly home: string;
    readonly inspection: EnvironmentInspection;
    /** How the runtime says it is signed in (`user`, `gh-cli`, `env`, …). */
    readonly authType?: string;
    /** The runtime could not be started: a short cause without paths. */
    readonly unavailable?: string;
}

export function copilotCliDoctor(inputs: readonly CopilotDoctorInput[]): DoctorReport {
    const findings: DoctorFinding[] = [];

    const byHome = new Map<string, { isDefault: boolean; ids: EnvironmentId[]; names: string[] }>();
    for (const { env, home } of inputs) {
        const key = configDirKey(home);
        const group = byHome.get(key) ?? { isDefault: env.profileDir === undefined, ids: [], names: [] };
        group.ids.push(env.id);
        group.names.push(env.name);
        byHome.set(key, group);
    }
    for (const group of byHome.values()) {
        if (group.ids.length < 2) continue;
        findings.push({
            level: 'error',
            code: COPILOT_CLI_DOCTOR_CODES.sharedHome,
            message: `Environments ${group.names.map((n) => `"${n}"`).join(', ')} share ${group.isDefault ? 'the default Copilot home' : 'one Copilot profile directory'}: they would use one GitHub account. Give each its own profile (\`agentic-daemon env add\` allocates one).`,
            environmentIds: group.ids
        });
    }

    for (const { env, inspection, authType, unavailable } of inputs) {
        if (env.profileDir === undefined) {
            findings.push({
                level: 'warn',
                code: COPILOT_CLI_DOCTOR_CODES.defaultHome,
                message: `Environment "${env.name}" has no profile of its own and uses the default Copilot home and GitHub CLI login; it is not isolated from Copilot run by hand on this machine.`,
                environmentIds: [env.id]
            });
        }
        if (unavailable !== undefined) {
            findings.push({
                level: 'error',
                code: COPILOT_CLI_DOCTOR_CODES.runtimeUnavailable,
                message: `Environment "${env.name}": the Copilot runtime could not be started (${unavailable}). It needs Node 20.19+ or 22.12+; run \`agentic-daemon doctor\` on the machine for details.`,
                environmentIds: [env.id]
            });
            continue;
        }
        const login = `\`agentic-daemon env login ${env.id}\``;
        const who = inspection.identity === undefined ? '' : ` (${inspection.identity})`;
        const auth = `Environment "${env.name}": auth ${inspection.authStatus}${who}.`;
        const code = AUTH_CODES[inspection.authStatus];
        if (inspection.authStatus === 'ok' && env.profileDir !== undefined && (authType === 'gh-cli' || authType === 'env')) {
            findings.push({
                level: 'warn',
                code: COPILOT_CLI_DOCTOR_CODES.sharedLogin,
                message: `Environment "${env.name}" has no Copilot login of its own and runs on this machine's ${authType === 'gh-cli' ? 'GitHub CLI login' : 'token variable'}${who}, which other environments may share. Sign it in with ${login}.`,
                environmentIds: [env.id]
            });
        } else if (inspection.authStatus === 'ok') findings.push({ level: 'info', code, message: auth, environmentIds: [env.id] });
        else findings.push({ level: 'warn', code, message: `${auth} Sign in on the machine with ${login}.`, environmentIds: [env.id] });
    }

    return { ok: !findings.some((f) => f.level === 'error'), findings };
}
