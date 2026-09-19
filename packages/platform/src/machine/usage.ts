/**
 * `usageLimitsOf` — the `usage_limits` answer (#272, part of #261) from the
 * machines a caller could read: every reported environment as a
 * `QuotaAccount` with its latest snapshot and how old it is. Shared by the
 * MCP port (`apps/web`) and the agent tool (`routing/tools.ts`).
 */
import type { QuotaAccount, UsageLimits, UsageLimitsQuery } from '@agentic/core';
import type { MachineView } from './actor.js';

export function usageLimitsOf(machines: readonly MachineView[], query: UsageLimitsQuery, now: number): UsageLimits {
    const accounts: QuotaAccount[] = [];
    for (const m of machines) {
        if (query.machineId !== undefined && m.machineId !== query.machineId) continue;
        for (const env of m.environments) {
            if (query.runtime !== undefined && env.runtime !== query.runtime) continue;
            const snapshot = m.quota?.[env.id] ?? null;
            accounts.push({
                machineId: m.machineId,
                machineName: m.name || m.machineId,
                online: m.online && !m.revoked,
                environmentId: env.id,
                runtime: env.runtime,
                account: { label: env.account.label, ...(env.account.identity ? { identity: env.account.identity } : {}) },
                snapshot,
                ageMs: snapshot ? Math.max(0, now - snapshot.observedAt) : null
            });
        }
    }
    return { accounts };
}
