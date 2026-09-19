/**
 * Provider limits on `/usage` and Home (#270, part of #261): one row per
 * account — an environment on a machine, or the platform's own runtime —
 * with its latest `QuotaSnapshot` (or `null` before the first report).
 * Pure, so the mock and the live page build the same rows.
 */
import type { EnvironmentDescriptor, QuotaSnapshot } from '@agentic/core';
import type { MachineView } from '@agentic/platform';

export interface LimitAccount {
    readonly key: string;
    /** `work · andy@acme` */
    readonly title: string;
    /** `alien01 · claude-code`, plus `offline` when the machine is. */
    readonly caption: string;
    readonly snapshot: QuotaSnapshot | null;
}

export function limitAccountOf(env: EnvironmentDescriptor, machineName: string, online: boolean, snapshot: QuotaSnapshot | null): LimitAccount {
    return {
        key: env.id,
        title: env.account.identity ? `${env.account.label} · ${env.account.identity}` : env.account.label,
        caption: `${machineName} · ${env.runtime}${online ? '' : ' · offline'}`,
        snapshot
    };
}

/** Every environment of every machine read, in the order given. */
export function limitAccountsOf(machines: readonly MachineView[]): LimitAccount[] {
    return machines.flatMap((m) => m.environments.map((env) => limitAccountOf(env, m.name || m.machineId, m.online && !m.revoked, m.quota?.[env.id] ?? null)));
}
