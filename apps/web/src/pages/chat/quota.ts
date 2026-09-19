/**
 * Whose limits a chat shows for a member (#315): the account of the environment it runs on here — its working
 * folder's environment in this chat, else its agent's default — so the person picking who works sees the headroom.
 */
import type { QuotaSnapshot } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import type { AgentIdentity } from './live';

/** A model runtime runs on the workspace's API key: per-minute rate limits, no plan allowance to show. */
export const NO_PLAN_LIMITS = 'No plan limits · API key';

/** `QuotaBadge` props for an agent: its environment's snapshot, or why there is none. */
export function memberQuota(agent: Pick<AgentIdentity, 'environment' | 'environmentId'>, workdirEnvironmentId: string | undefined, environments: readonly WorkdirEnvironment[]): { snapshot?: QuotaSnapshot | null; note?: string } {
    if (agent.environment.runtime === 'anthropic-api') return { note: NO_PLAN_LIMITS };
    const id = workdirEnvironmentId ?? agent.environmentId;
    if (!id) return { note: 'No environment chosen' };
    const env = environments.find((e) => e.id === id);
    if (!env) return { note: 'Environment not reported' };
    return env.quota === undefined ? {} : { snapshot: env.quota };
}
