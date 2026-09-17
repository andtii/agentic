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
    type InstructionProposal,
    type PendingProposal,
    type ProposalOrigin,
    type ProposalStatus,
    appendInstruction,
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
    /** Instruction proposals waiting for review (LRN-08). */
    readonly pendingProposals: number;
}

const PROPOSAL_ORIGINS: ReadonlySet<string> = new Set<ProposalOrigin['kind']>(['task-end', 'correction']);

/** Only the review-gated shape is parked; anything else is a `TypeError`, never a silent drop. */
function assertInstructionProposal(p: unknown, i: number): asserts p is InstructionProposal {
    const x = p as Partial<InstructionProposal> | null;
    if (!x || typeof x !== 'object' || x.kind !== 'instruction') throw new TypeError(`proposal ${i} is not an instruction proposal`);
    if (typeof x.patch !== 'string' || !x.patch.trim()) throw new TypeError(`proposal ${i} needs a patch`);
    if (typeof x.reason !== 'string') throw new TypeError(`proposal ${i} needs a reason`);
    if (x.requiresReview !== true) throw new TypeError(`proposal ${i} must require review`);
}

function assertOrigin(origin: unknown): asserts origin is ProposalOrigin {
    const o = origin as Partial<ProposalOrigin> | null;
    if (!o || typeof o !== 'object' || !PROPOSAL_ORIGINS.has(String(o.kind)) || typeof o.sessionId !== 'string' || !o.sessionId) {
        throw new TypeError('a proposal needs an origin { kind: task-end | correction, sessionId }');
    }
}

/** Reviews are a human act (LRN-08): users and external clients only. */
const reviewer = (principal: Principal | null): boolean => principal?.kind === 'user' || principal?.kind === 'external';
/** An agent parks proposals on itself only; users and external clients on any agent of the workspace. */
const proposer = (principal: Principal | null, _rq: unknown, op: { resource?: { key: string } }): boolean =>
    principal !== null && principal.kind !== 'machine' && (principal.kind !== 'agent' || op.resource?.key === agentKey(principal.workspaceId, principal.agentId));

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
    methodAuthorize: { propose: proposer, reviewProposal: reviewer },
    state: initialAgentState,
    methods: (ctx) => {
        const proposals = (): PendingProposal[] => (ctx.state.proposals ??= []);

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
                return {
                    id,
                    workspaceId,
                    configVersion,
                    config: ctx.snapshot(ctx.state.config),
                    memoryScope: agentMemoryScope(id),
                    pendingProposals: proposals().filter((p) => p.status === 'pending').length
                };
            },

            /**
             * Park instruction proposals for review (LRN-08). Nothing is applied
             * here. A pending proposal with the same patch is returned instead of
             * a duplicate — learning proposes the same instruction on every
             * repetition. Memory proposals are refused: the plugin applies those.
             */
            async propose(items: readonly InstructionProposal[], origin: ProposalOrigin): Promise<readonly PendingProposal[]> {
                assertOrigin(origin);
                if (!Array.isArray(items)) throw new TypeError('propose() takes a list of proposals');
                items.forEach(assertInstructionProposal);
                const by = principalLabel(ctx.principal);
                const at = Date.now();
                const out: PendingProposal[] = [];
                let appended = false;
                for (const proposal of items) {
                    const patch = proposal.patch.trim();
                    const same = proposals().find((p) => p.status === 'pending' && p.proposal.patch.trim() === patch);
                    if (same) {
                        out.push(same);
                        continue;
                    }
                    const id = `prop_${proposals().length + 1}`;
                    applyAgentEntry(ctx.state, {
                        t: 'proposal',
                        id,
                        proposal: { kind: 'instruction', patch, reason: proposal.reason, requiresReview: true },
                        origin: clone(origin),
                        by,
                        at
                    });
                    appended = true;
                    out.push(proposals().at(-1)!);
                }
                if (appended) await ctx.save();
                return ctx.snapshot(out);
            },

            async listProposals(status?: ProposalStatus): Promise<readonly PendingProposal[]> {
                return ctx.snapshot(status === undefined ? proposals() : proposals().filter((p) => p.status === status));
            },

            /**
             * Accept — the patch lands as a NEW config version with the proposal
             * appended to `instructions`, reversible by `rollback` (AGT-06) — or
             * reject. Either way the proposal leaves the pending queue.
             */
            async reviewProposal(id: string, decision: 'accept' | 'reject', reason?: string): Promise<PendingProposal> {
                if (decision !== 'accept' && decision !== 'reject') throw new TypeError(`unknown review decision "${String(decision)}"`);
                if (reason !== undefined) assertReason(reason);
                const p = proposals().find((x) => x.id === id);
                if (!p) throw new RangeError(`no agent proposal ${id}`);
                if (p.status !== 'pending') throw new RangeError(`agent proposal ${id} is already ${p.status}`);
                let version: number | undefined;
                if (decision === 'accept') {
                    const info = await commit({ instructions: appendInstruction(ctx.state.config.instructions, p.proposal.patch) }, reason ?? `accepted proposal ${id}: ${p.proposal.reason}`);
                    version = info.version;
                }
                applyAgentEntry(ctx.state, {
                    t: 'review',
                    id,
                    decision,
                    by: principalLabel(ctx.principal),
                    at: Date.now(),
                    ...(reason === undefined ? {} : { reason }),
                    ...(version === undefined ? {} : { version })
                });
                await ctx.save();
                return ctx.snapshot(proposals().find((x) => x.id === id)!);
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
