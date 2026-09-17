/**
 * The Agent actor — a persistent identity whose configuration is versioned
 * and reversible, and whose sessions record the exact config they ran with
 * (architecture §4; AGT-01..08, LRN-08).
 *
 * Keyed `{ws}:agent:{id}`. Identity and config live in the actor's record,
 * so an agent persists with no running process (AGT-08); the workspace
 * prefix lets `authorize` refuse a foreign caller before any state loads.
 */

import { defineActor } from '@sigx/actors';
import {
    type AgentId,
    type FrozenAgentConfig,
    type MemoryScope,
    type Principal,
    type WorkspaceId,
    actorKey,
    hasScope,
    sameWorkspace
} from '@agentic/core';
import { type AgentConfigPatch, assertAgentConfigPatch, clone } from './config.js';
import {
    type AgentConfigEntry,
    type AgentState,
    type AgentVersionInfo,
    applyAgentEntry,
    configAtVersion,
    initialAgentState,
    versionInfo
} from './entries.js';

/** The key of workspace `ws`'s agent `id`: `{ws}:agent:{id}`. */
export function agentKey(workspaceId: WorkspaceId, id: AgentId): string {
    return actorKey(workspaceId, 'agent', id);
}

/** An agent's private memory scope is its own id (AGT-03). */
export function agentMemoryScope(id: AgentId): MemoryScope {
    return `agent:${id}`;
}

/** What `get()` returns — the folded state, versions elided. */
export interface AgentView {
    readonly id: AgentId;
    readonly workspaceId: WorkspaceId;
    readonly configVersion: number;
    readonly config: AgentState['config'];
    readonly memoryScope: MemoryScope;
}

/** The `by` a version records for the calling principal. */
export function principalLabel(principal: unknown): string {
    const p = principal as Principal | null | undefined;
    switch (p?.kind) {
        case 'user':
            return `user:${p.userId}`;
        case 'agent':
            return `agent:${p.agentId}`;
        case 'machine':
            return `machine:${p.machineId}`;
        case 'external':
            return `external:${p.clientId}`;
        default:
            return 'system';
    }
}

export const AgentActor = defineActor({
    type: 'Agent',
    /** Same workspace, and an external client needs the `agents` scope (§9). */
    authorize: (principal: Principal | null, _rq, op) =>
        principal !== null && op.resource !== undefined && sameWorkspace(principal, op.resource.key) && hasScope(principal, 'agents'),
    state: initialAgentState,
    methods: (ctx) => {
        /** One durable version: fold, then persist inside the same turn (Workers eviction rule). */
        async function commit(patch: AgentConfigPatch, reason: string, rollbackOf?: number): Promise<AgentVersionInfo> {
            const entry: AgentConfigEntry = {
                t: 'config',
                v: ctx.state.configVersion + 1,
                patch,
                by: principalLabel(ctx.principal),
                at: Date.now(),
                reason,
                ...(rollbackOf === undefined ? {} : { rollbackOf })
            };
            applyAgentEntry(ctx.state, entry);
            await ctx.save();
            return versionInfo(entry);
        }

        return {
            async get(): Promise<AgentView> {
                const { id, workspaceId, configVersion } = ctx.state;
                return { id, workspaceId, configVersion, config: ctx.snapshot(ctx.state.config), memoryScope: agentMemoryScope(id) };
            },

            /** Apply `patch` as a new version. The first update on a fresh agent creates v1. */
            async update(patch: AgentConfigPatch, reason: string): Promise<AgentVersionInfo> {
                assertAgentConfigPatch(patch);
                assertReason(reason);
                return commit(clone(patch), reason);
            },

            /**
             * A NEW version whose config equals version `toVersion` — history is
             * never rewritten, so the rollback itself is reversible (AGT-06).
             */
            async rollback(toVersion: number, reason?: string): Promise<AgentVersionInfo> {
                if (reason !== undefined) assertReason(reason);
                const target = configAtVersion(ctx.state.versions, toVersion);
                return commit(target, reason ?? `rollback to v${toVersion}`, toVersion);
            },

            async listVersions(): Promise<readonly AgentVersionInfo[]> {
                return ctx.state.versions.map(versionInfo);
            },

            /**
             * The config a session starts with — a detached copy stamped with
             * `configVersion`, so later updates never reach it (AGT-06/07).
             */
            async snapshotForSession(): Promise<FrozenAgentConfig> {
                if (ctx.state.configVersion === 0) {
                    throw new Error(`agent ${ctx.state.id} has no configuration yet (update it first)`);
                }
                return { ...ctx.snapshot(ctx.state.config), agentId: ctx.state.id, configVersion: ctx.state.configVersion };
            }
        };
    }
});

function assertReason(reason: unknown): asserts reason is string {
    if (typeof reason !== 'string' || reason.trim() === '') {
        throw new TypeError('a config version needs a non-empty reason');
    }
}
