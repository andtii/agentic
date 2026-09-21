/**
 * Whose limits a chat shows for a member (#315): the account of the environment it runs on here — its working
 * folder's environment in this chat, else its account's environment on the chat's machine (#414), else its agent's
 * default — so the person picking who works sees the headroom.
 */
import type { AccountRef, QuotaSnapshot, RuntimeId } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import type { AgentIdentity } from './live';

/** A model runtime runs on the workspace's API key: per-minute rate limits, no plan allowance to show. */
export const NO_PLAN_LIMITS = 'No plan limits · API key';

/** Where the chat runs (#414): the machine, and how the account's environment there is found. */
export interface QuotaMachine {
    readonly machineId: string;
    readonly machineName?: string;
    accountEnvironment(machineId: string, runtime: RuntimeId, ref: AccountRef): string | undefined;
}

/** `QuotaBadge` props for an agent: its environment's snapshot, or why there is none. */
export function memberQuota(agent: Pick<AgentIdentity, 'environment' | 'environmentId' | 'account'>, workdirEnvironmentId: string | undefined, environments: readonly WorkdirEnvironment[], on?: QuotaMachine): { snapshot?: QuotaSnapshot | null; note?: string } {
    if (agent.environment.runtime === 'anthropic-api') return { note: NO_PLAN_LIMITS };
    let id = workdirEnvironmentId;
    if (!id && on && agent.account) {
        id = on.accountEnvironment(on.machineId, agent.environment.runtime, agent.account);
        if (!id) return { note: `Not signed in on ${on.machineName ?? on.machineId}` };
    }
    id ??= agent.environmentId;
    if (!id) return { note: agent.account ? 'No machine chosen' : 'No environment chosen' };
    const env = environments.find((e) => e.id === id);
    if (!env) return { note: 'Environment not reported' };
    return env.quota === undefined ? {} : { snapshot: env.quota };
}
