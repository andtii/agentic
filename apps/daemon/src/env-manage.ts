/**
 * `env.request` (#236/#238, decisions 2026-09-19 (c)): the platform asks this
 * machine to add, change or remove an environment, and the machine decides.
 *
 * The decision rests on `policy.json` (`policy.ts`; set on the machine or,
 * since #355, from the web through `policy-web.ts`): with the policy off every
 * request is refused; with it on, every working root must pass
 * `checkWorkingRoot`. Nothing here writes the policy, and nothing the request
 * carries chooses a `profileDir` — a new environment gets
 * `<configDir>/profiles/<id>`, a changed one keeps its own.
 * What is written goes through `env-store.ts`, the same writer `env add` uses.
 *
 * Failures that are the machine's own business (`environments.json` is
 * invalid, a write failed) are answered `io` with a message that names no
 * path; the details go to the daemon's log.
 */

import type { EnvError, EnvErrorCode, EnvOp, EnvResult, EnvironmentId, LocalEnvironment, MachinePolicy } from '@agentic/core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecureWriteOptions } from './credentials.js';
import { addEnvironment, EnvironmentStoreError, readEnvironmentsForEdit, removeEnvironment, writeEnvironments } from './env-store.js';
import { silentLogger, type Logger } from './logger.js';
import type { DaemonPaths } from './paths.js';
import { checkWorkingRoot } from './policy.js';

export type EnvOutcome =
    /** `environments`: what `environments.json` now holds — the daemon runs with exactly this. */
    { readonly result: EnvResult; readonly environments: readonly LocalEnvironment[] } | { readonly error: EnvError };

export interface EnvManageContext {
    readonly paths: Pick<DaemonPaths, 'configDir' | 'stateDir' | 'environmentsFile'>;
    /** The policy as loaded from disk on this machine — never anything from the wire. */
    readonly policy: MachinePolicy;
    /** The runtimes this daemon has a driver for. */
    readonly runtimes: ReadonlySet<string>;
    /** Sessions running or opening on an environment. */
    activeOn(environmentId: EnvironmentId): number;
    readonly platform?: NodeJS.Platform;
    readonly secure?: SecureWriteOptions;
    readonly logger?: Logger;
}

const fail = (code: EnvErrorCode, message: string): { error: EnvError } => ({ error: { code, message: message.slice(0, 1024) } });

/** Answer one `env.request`. Never throws; call it one at a time (it reads, changes and writes `environments.json`). */
export async function answerEnvRequest(op: EnvOp, c: EnvManageContext): Promise<EnvOutcome> {
    const logger = c.logger ?? silentLogger;
    const platform = c.platform ?? process.platform;
    if (!c.policy.webManaged || c.policy.allowedRoots.length === 0) {
        return fail('policy-disabled', 'this machine does not let the web manage its environments — allow a folder on the machine with `agentic-daemon policy allow-root <dir>`');
    }
    try {
        let current: readonly LocalEnvironment[];
        try {
            current = await readEnvironmentsForEdit(c.paths.environmentsFile);
        } catch (e) {
            logger.error('env: environments.json cannot be edited', { error: e });
            return fail('io', "the machine's environments.json is invalid; fix it on the machine (`agentic-daemon doctor` shows what is wrong)");
        }

        if (op.op === 'remove') {
            if (!current.some((e) => e.id === op.environmentId)) return fail('unknown-environment', `no environment ${op.environmentId} on this machine`);
            if (c.activeOn(op.environmentId) > 0) return fail('in-use', `environment ${op.environmentId} has running sessions; close them first`);
            const { environments } = removeEnvironment(current, op.environmentId);
            await writeEnvironments(c.paths.environmentsFile, environments, c.secure);
            logger.info('env: removed by the platform', { environment: op.environmentId });
            return { result: { environmentId: op.environmentId }, environments };
        }

        if (op.op !== 'put') return fail('invalid', `unknown env op ${String((op as { op?: unknown }).op)}`);
        // Only the fields the contract names are read: whatever else a frame carried (a `profileDir`, say) is never looked at.
        const input = op.environment;
        if (typeof input?.runtime !== 'string' || !c.runtimes.has(input.runtime)) return fail('unknown-runtime', `this machine has no driver for runtime ${JSON.stringify(input?.runtime)}`);
        const existing = input.id === undefined ? undefined : current.find((e) => e.id === input.id);
        // Its profile holds a sign-in for the runtime it was made for.
        if (existing && existing.runtime !== input.runtime) return fail('invalid', `environment ${existing.id} runs ${existing.runtime}; remove it and add another to change the runtime`);
        if (!Array.isArray(input.cwdRoots) || input.cwdRoots.length === 0) return fail('invalid', 'an environment needs at least one working root');

        const own = { configDir: c.paths.configDir, stateDir: c.paths.stateDir, profileDirs: [join(c.paths.configDir, 'profiles'), ...current.flatMap((e) => (e.profileDir === undefined ? [] : [e.profileDir]))] };
        const roots: string[] = [];
        for (const root of input.cwdRoots) {
            const checked = await checkWorkingRoot(root, c.policy.allowedRoots, own, platform);
            if (!checked.ok) return fail(checked.code, checked.message);
            if (!roots.includes(checked.real)) roots.push(checked.real);
        }

        // An existing environment keeps what the request leaves out (`replace` alone would drop them).
        // A number sets the limit, `null` clears it (no limit, #694), absent keeps the environment's.
        const concurrency = input.concurrency === null ? undefined : (input.concurrency ?? existing?.concurrency);
        const accountLabel = input.accountLabel ?? existing?.accountLabel;
        // `allowBypassPermissions` (#355): `true` sets, `false` clears, absent keeps — the platform admits turning it on to an elevated owner only.
        const allowBypassPermissions = typeof input.allowBypassPermissions === 'boolean' ? input.allowBypassPermissions : undefined;
        const { environments, environment } = addEnvironment(
            current,
            { ...(input.id === undefined ? {} : { id: input.id }), name: input.name, runtime: input.runtime, cwdRoots: roots, ...(concurrency === undefined ? {} : { concurrency }), ...(accountLabel === undefined ? {} : { accountLabel }), ...(allowBypassPermissions === undefined ? {} : { allowBypassPermissions }) },
            c.paths,
            { replace: existing !== undefined, platform }
        );
        if (environment.profileDir !== undefined) await mkdir(environment.profileDir, { recursive: true });
        await writeEnvironments(c.paths.environmentsFile, environments, c.secure);
        logger.info(existing ? 'env: changed by the platform' : 'env: added by the platform', { environment: environment.id, roots });
        return { result: { environmentId: environment.id }, environments };
    } catch (e) {
        if (e instanceof EnvironmentStoreError) {
            // `invalid` speaks about the input (a name, an id, a number); the others cannot come from a web put and name local paths.
            if (e.code === 'invalid') return fail('invalid', e.message);
            // The profile this id would get already belongs to another environment.
            if (e.code === 'shared-profile-dir') return fail('invalid', 'that environment id is taken on this machine; choose another');
            logger.error('env: request refused by the store', { code: e.code, error: e });
            return fail('io', 'the machine could not save the environment; see the daemon log');
        }
        logger.error('env: request failed', { error: e });
        return fail('io', 'the machine could not save the environment; see the daemon log');
    }
}
