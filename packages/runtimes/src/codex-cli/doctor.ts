/**
 * `doctor` for Codex environments (EXE-07): isolation is one `CODEX_HOME` per account, so two
 * environments on one home share a login and a config — an error, never tolerated. Pure: each
 * environment's auth comes in from `inspect`. Like Claude Code's, findings name environments and
 * the local command that fixes them, never a path (#274).
 */

import type { DoctorFinding, DoctorReport, EnvironmentId, EnvironmentInspection, LocalEnvironment } from '@agentic/core';
import { configDirKey } from '../claude-code/doctor.js';

export const CODEX_CLI_DOCTOR_CODES = {
    /** error: two environments resolve to one `CODEX_HOME` — one account, one config (EXE-07). */
    sharedHome: 'shared-home',
    /** warn: no `profileDir`; the default `~/.codex` is shared with Codex run by hand. */
    defaultHome: 'default-home',
    authOk: 'auth-ok',
    authUnknown: 'auth-unknown',
    authMissing: 'auth-missing',
    authExpired: 'auth-expired',
    /** error: no `codex` executable (nor the bundled `@openai/codex`) could be found. */
    cliMissing: 'cli-missing',
    /** warn: Codex was found but its app-server did not answer. */
    appServerFailed: 'app-server-failed'
} as const;

const AUTH_CODES: Record<EnvironmentInspection['authStatus'], string> = {
    ok: CODEX_CLI_DOCTOR_CODES.authOk,
    unknown: CODEX_CLI_DOCTOR_CODES.authUnknown,
    missing: CODEX_CLI_DOCTOR_CODES.authMissing,
    expired: CODEX_CLI_DOCTOR_CODES.authExpired
};

export interface CodexDoctorInput {
    readonly env: LocalEnvironment;
    /** The `CODEX_HOME` Codex will use: `profileDir`, or the default. */
    readonly home: string;
    readonly inspection: EnvironmentInspection;
    /** Codex could not be asked: `'cli-missing'`, or the failure's code — never its message, which may name a path. */
    readonly unavailable?: 'cli-missing' | (string & {});
}

export function codexCliDoctor(inputs: readonly CodexDoctorInput[]): DoctorReport {
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
            code: CODEX_CLI_DOCTOR_CODES.sharedHome,
            message: `Environments ${group.names.map((n) => `"${n}"`).join(', ')} share ${group.isDefault ? 'the default Codex home' : 'one Codex profile directory'}: they would use one account and one config. Give each its own profile (\`agentic-daemon env add\` allocates one).`,
            environmentIds: group.ids
        });
    }

    for (const { env, inspection, unavailable } of inputs) {
        if (env.profileDir === undefined) {
            findings.push({
                level: 'warn',
                code: CODEX_CLI_DOCTOR_CODES.defaultHome,
                message: `Environment "${env.name}" has no profile of its own and uses the default Codex home; it is not isolated from Codex run by hand on this machine.`,
                environmentIds: [env.id]
            });
        }
        if (unavailable === 'cli-missing') {
            findings.push({
                level: 'error',
                code: CODEX_CLI_DOCTOR_CODES.cliMissing,
                message: `Environment "${env.name}": Codex is not installed on this machine. Install it (\`npm i -g @openai/codex\`) or reinstall the daemon.`,
                environmentIds: [env.id]
            });
            continue;
        }
        if (unavailable !== undefined) {
            findings.push({
                level: 'warn',
                code: CODEX_CLI_DOCTOR_CODES.appServerFailed,
                message: `Environment "${env.name}": Codex did not answer (${unavailable}). Run \`agentic-daemon doctor\` on the machine for details.`,
                environmentIds: [env.id]
            });
            continue;
        }
        const login = `\`agentic-daemon env login ${env.id}\``;
        const who = inspection.identity === undefined ? '' : ` (${inspection.identity})`;
        const auth = `Environment "${env.name}": auth ${inspection.authStatus}${who}.`;
        const code = AUTH_CODES[inspection.authStatus];
        if (inspection.authStatus === 'ok') findings.push({ level: 'info', code, message: auth, environmentIds: [env.id] });
        else if (inspection.authStatus === 'unknown') findings.push({ level: 'warn', code, message: `${auth} Check it on the machine with ${login}.`, environmentIds: [env.id] });
        else findings.push({ level: 'warn', code, message: `${auth} Sign in on the machine with ${login}.`, environmentIds: [env.id] });
    }

    return { ok: !findings.some((f) => f.level === 'error'), findings };
}
