/**
 * The memory and learning steps of the execution path (architecture §7
 * driver, §8; MEM-07/10/11, LRN-02/03/05/08, AC-09):
 *
 * - before the first prompt: `retrieveMemories` queries the assignee's own
 *   scope plus its declared shared scopes UNDER THE AGENT PRINCIPAL (so the
 *   Memory actor's ACL decides, MEM-11), merges the hits under one budget and
 *   `renderMemoryBlock` turns them into a system block labelled as
 *   platform-owned (MEM-10);
 * - after a turn: `taskOutcomeOf` builds the `TaskOutcome` with claimed and
 *   verified success kept apart (LRN-03) for `LearningPlugin.onTaskEnd`;
 * - a user's "Correct": `correctionOf` builds the `Correction` for
 *   `LearningPlugin.onCorrection`.
 *
 * Memory proposals are applied by the plugin; instruction proposals are
 * parked for review through `LearningPorts.park` (the Agent actor by default)
 * and never applied here. Pure over the `MemoryStore` and `LearningPlugin`
 * seams; the Session actor composes them, and a Task driver may too.
 */

import type {
    AgentId,
    Correction,
    FrozenAgentConfig,
    LearningPlugin,
    MemoryEntry,
    MemoryQuery,
    MemoryScope,
    MemoryStore,
    MessageId,
    Principal,
    PromptPart,
    Proposal,
    SessionId,
    TaskId,
    TaskOutcome,
    TaskResult,
    WorkspaceId
} from '@agentic/core';
import { actor } from '@sigx/actors';
import { AgentActor, agentKey } from '../agent/agent.actor.js';
import type { InstructionProposal, ProposalOrigin } from '../agent/entries.js';
import { asPrincipal } from '../auth/agent-token.js';
import { Memory } from '../memory/actor.js';
import { actorMemoryStore, memoryActorKey, type MemoryActorClient } from '../memory/plugin.js';
import type { RegistryGate } from '../registry/types.js';

/**
 * The heading of the injected block. The same literal the Claude Code driver
 * relabels `## Memory` to (`@agentic/runtimes/claude-code` `PLATFORM_MEMORY_HEADING`),
 * so a prompt that already carries this block passes through it unchanged.
 */
export const PLATFORM_MEMORY_HEADING = '## Platform memory';

export const PLATFORM_MEMORY_NOTE =
    "Supplied by the agentic platform from this agent's memory scopes for this session. It is platform-owned, not the runtime's own memory. Assumptions are marked as such; a lesson says when it applies. Keep what should outlive the session with memory_remember.";

/** Entries per session by default; the store's own default is 20. */
export const DEFAULT_RETRIEVAL_LIMIT = 8;
/** Bytes of memory text per session by default (MEM-07). */
export const DEFAULT_RETRIEVAL_MAX_BYTES = 4096;

export interface RetrievalBudget {
    /** Entries at most, across every scope. Default `DEFAULT_RETRIEVAL_LIMIT`. */
    readonly limit?: number;
    /** Bytes of `text` at most, across every scope. Default `DEFAULT_RETRIEVAL_MAX_BYTES`. */
    readonly maxBytes?: number;
}

/** What retrieval keys on: the task objective and the latest user message (MEM-07). */
export interface RetrievalContext {
    readonly objective?: string;
    /** The prompt parts the work starts from; the last text part is the latest user message. */
    readonly context?: readonly PromptPart[];
    readonly tags?: readonly string[];
}

/** A `MemoryStore` for `scope`, whose every call runs as `principal`. */
export type MemoryOpener = (scope: MemoryScope, principal: Principal) => MemoryStore;

export interface RetrievedMemory {
    readonly scope: MemoryScope;
    readonly entry: MemoryEntry;
    readonly score: number;
}

/** A scope that answered nothing: refused by its ACL, or failed. Listed, never hidden (OPS-04). */
export interface SkippedScope {
    readonly scope: MemoryScope;
    readonly reason: string;
}

export interface RetrievedMemories {
    /** The query text the scopes were ranked on. */
    readonly text: string;
    readonly scopes: readonly MemoryScope[];
    readonly skipped: readonly SkippedScope[];
    readonly hits: readonly RetrievedMemory[];
    /** `hits`, entries only, in rank order. */
    readonly entries: readonly MemoryEntry[];
}

export type { InstructionProposal, ProposalOrigin };
export type MemoryProposal = Extract<Proposal, { readonly kind: 'memory' }>;

/** Park instruction proposals for review on behalf of `agent`, as `principal`. */
export type ProposalParker = (
    agent: { readonly workspaceId: WorkspaceId; readonly agentId: AgentId },
    proposals: readonly InstructionProposal[],
    origin: ProposalOrigin,
    principal: Principal
) => Promise<void>;

/** What a verification step sees (LRN-03); `result.verified` is false until one says otherwise. */
export interface VerificationInput {
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    readonly turnId: string;
    readonly status: TaskOutcome['status'];
    readonly result: TaskResult;
}

export type Verdict = 'verified' | 'refuted';

/** What a session knows about its work — the `contextFor` a learning plugin needs for a correction's conditions and tags. */
export interface LearningSessionContext {
    readonly workspaceId: WorkspaceId;
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly taskId?: TaskId;
    readonly objective?: string;
    readonly tags?: readonly string[];
}

/** A plugin per session, built over the session's context: `(c) => learningPlugin({ contextFor: () => c, ledger })`. */
export type LearningPluginFactory = (context: LearningSessionContext) => LearningPlugin;

/** The plugin for `context`: the one given, or one the factory builds. */
export function learningPluginFor(plugin: LearningPlugin | LearningPluginFactory | undefined, context: LearningSessionContext): LearningPlugin | undefined {
    return typeof plugin === 'function' ? plugin(context) : plugin;
}

/** The seams the Session actor learns through (architecture §8). */
export interface LearningPorts {
    readonly memory: MemoryOpener;
    /**
     * Without one, memory is retrieved but nothing is learned; `correct` refuses. A factory gets the
     * session's context, so a correction's lesson carries the task's objective as its conditions.
     */
    readonly plugin?: LearningPlugin | LearningPluginFactory;
    readonly retrieval?: RetrievalBudget;
    /** Default: `AgentActor.propose` under the agent principal. */
    readonly park?: ProposalParker;
    /** An independent check of a turn's result; `undefined` leaves the claim a claim. */
    readonly verify?: (input: VerificationInput) => Promise<Verdict | undefined> | Verdict | undefined;
    /**
     * The build's memory plugins by id (#242). With a Registry answer on the session spec (`spec.plugins`), the
     * workspace's ACTIVE memory plugin — built over its config — replaces `memory` and `retrieval`; without one
     * (no Registry behind the router, a test) `memory` and `retrieval` are used as they are.
     */
    readonly memoryPlugins?: Readonly<Record<string, MemoryPluginImpl>>;
    /** The build's learning plugins by id (#242); the active one replaces `plugin` the same way. */
    readonly learningPlugins?: Readonly<Record<string, LearningPluginImpl>>;
}

/** A memory plugin as the platform runs it (#242): a store per scope, reached as a principal, and the session-start budget its config asks for. */
export interface PlatformMemory {
    readonly open: MemoryOpener;
    /** Absent → the ports' own `retrieval`. */
    readonly retrieval?: RetrievalBudget;
}

/** A memory plugin's implementation over its Registry config (defaults filled in). */
export type MemoryPluginImpl = (config: Readonly<Record<string, unknown>>) => PlatformMemory;
/** A learning plugin's implementation over its Registry config. */
export type LearningPluginImpl = (config: Readonly<Record<string, unknown>>) => LearningPlugin | LearningPluginFactory;

/** A session's memory: a store to open, or why it has none. */
export type SessionMemory = PlatformMemory | { readonly off: string };
/** A session's learning: the plugin, or why it has none (`{}` — nothing configured, as without a plugin port). */
export interface SessionLearning {
    readonly plugin?: LearningPlugin | LearningPluginFactory;
    readonly off?: string;
}

export const MEMORY_OFF = 'memory is turned off for this workspace';
export const LEARNING_OFF = 'learning is turned off for this workspace';

function implOf<T>(impls: Readonly<Record<string, T>>, id: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(impls, id) ? impls[id] : undefined;
}

/**
 * Which store a session remembers in (#242): the workspace's active memory plugin as the gate reported it on the
 * spec. Turned off, or not implemented by this build → `{ off }`, and nothing is retrieved or written; the stored
 * memories are left as they are. No gate, no memory plugin in it, or no `memoryPlugins` port → the static wiring.
 */
export function memoryAccess(ports: Pick<LearningPorts, 'memory' | 'retrieval' | 'memoryPlugins'>, gate?: RegistryGate): SessionMemory {
    const active = gate?.memory;
    if (!active || !ports.memoryPlugins) return { open: ports.memory, ...(ports.retrieval ? { retrieval: ports.retrieval } : {}) };
    if (!active.enabled) return { off: `${MEMORY_OFF}: the "${active.id}" memory plugin is turned off (turn it on at /plugins/${active.id})` };
    const impl = implOf(ports.memoryPlugins, active.id);
    if (!impl) return { off: `${MEMORY_OFF}: this deployment has no implementation of the "${active.id}" memory plugin` };
    const built = impl(active.config);
    const retrieval = built.retrieval ?? ports.retrieval;
    return { open: built.open, ...(retrieval ? { retrieval } : {}) };
}

/**
 * Which plugin a session learns through (#242), resolved like `memoryAccess`. Learning writes to memory, so memory
 * turned off turns learning off too.
 */
export function learningAccess(ports: Pick<LearningPorts, 'memory' | 'retrieval' | 'memoryPlugins' | 'plugin' | 'learningPlugins'>, gate?: RegistryGate): SessionLearning {
    const memory = memoryAccess(ports, gate);
    if ('off' in memory) return { off: `${LEARNING_OFF}: ${memory.off}` };
    const active = gate?.learning;
    if (!active || !ports.learningPlugins) return ports.plugin ? { plugin: ports.plugin } : {};
    if (!active.enabled) return { off: `${LEARNING_OFF}: the "${active.id}" learning plugin is turned off (turn it on at /plugins/${active.id})` };
    const impl = implOf(ports.learningPlugins, active.id);
    if (!impl) return { off: `${LEARNING_OFF}: this deployment has no implementation of the "${active.id}" learning plugin` };
    return { plugin: impl(active.config) };
}
const encoder = new TextEncoder();

/** The last text part — the latest user message. */
export function lastUserText(parts: readonly PromptPart[] | undefined): string {
    if (!parts) return '';
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        if (p.type === 'text' && p.text.trim()) return p.text.trim();
    }
    return '';
}

/** `objective` + the latest user message, deduplicated when they are the same text. */
export function retrievalText(context: RetrievalContext): string {
    const objective = context.objective?.trim() ?? '';
    const last = lastUserText(context.context);
    if (!objective) return last;
    if (!last || last === objective) return objective;
    return `${objective}\n${last}`;
}

/** A `memoryPolicy.shared` name as a scope: `shared:` is added unless a scope prefix is already there. */
export function sharedScope(name: string): MemoryScope {
    return name.startsWith('shared:') || name.startsWith('agent:') ? (name as MemoryScope) : `shared:${name}`;
}

/** The agent's own scope first, then its declared shared scopes, no duplicates (MEM-11). */
export function memoryScopesOf(config: Pick<FrozenAgentConfig, 'agentId' | 'memoryPolicy'>): readonly MemoryScope[] {
    const out: MemoryScope[] = [`agent:${config.agentId}`];
    for (const name of config.memoryPolicy.shared) {
        const scope = sharedScope(name);
        if (!out.includes(scope)) out.push(scope);
    }
    return out;
}

/** The query one scope answers (MEM-07): ranked on the text, filtered on the tags, capped twice. */
export function retrievalQuery(context: RetrievalContext, budget: RetrievalBudget = {}): MemoryQuery {
    const text = retrievalText(context);
    const tags = context.tags?.filter((t) => t.trim()) ?? [];
    return {
        ...(text ? { text } : {}),
        ...(tags.length ? { tags } : {}),
        limit: budget.limit ?? DEFAULT_RETRIEVAL_LIMIT,
        maxBytes: budget.maxBytes ?? DEFAULT_RETRIEVAL_MAX_BYTES
    };
}

/**
 * Query every scope of the agent as `principal`, then merge: best score first,
 * at most `limit` entries and `maxBytes` of text over the whole set (an
 * entry that does not fit is skipped, the next smaller one may). A scope the
 * principal may not read — the Memory actor refuses — is listed in `skipped`.
 */
export async function retrieveMemories(
    open: MemoryOpener,
    principal: Principal,
    config: Pick<FrozenAgentConfig, 'agentId' | 'memoryPolicy'>,
    context: RetrievalContext,
    budget: RetrievalBudget = {}
): Promise<RetrievedMemories> {
    const query = retrievalQuery(context, budget);
    const maxBytes = query.maxBytes ?? DEFAULT_RETRIEVAL_MAX_BYTES;
    const scopes = memoryScopesOf(config);
    const skipped: SkippedScope[] = [];
    const all: RetrievedMemory[] = [];
    // A budget of none asks no scope at all.
    if (query.limit <= 0) return { text: query.text ?? '', scopes, skipped, hits: [], entries: [] };
    for (const scope of scopes) {
        try {
            const ranked = await open(scope, principal).query(query);
            for (const { entry, score } of ranked) all.push({ scope, entry, score });
        } catch (error) {
            skipped.push({ scope, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    // Stable: equal scores keep scope order (own scope before shared).
    all.sort((a, b) => b.score - a.score);
    const hits: RetrievedMemory[] = [];
    let bytes = 0;
    for (const hit of all) {
        if (hits.length >= query.limit) break;
        const size = encoder.encode(hit.entry.text).byteLength;
        if (bytes + size > maxBytes) continue;
        bytes += size;
        hits.push(hit);
    }
    return { text: query.text ?? '', scopes, skipped, hits, entries: hits.map((h) => h.entry) };
}

function memoryLine(m: MemoryEntry): string {
    const subject = m.subject !== undefined ? ` (${m.subject})` : '';
    const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    const when = m.kind === 'lesson' && m.conditions ? ` — applies: ${m.conditions.replace(/\s*\n\s*/g, '; ')}` : '';
    return `- ${m.kind}/${m.confidence}${subject}: ${m.text}${tags}${when}`;
}

/** The platform-owned block, or `''` when there is nothing to inject. */
export function renderMemoryBlock(entries: readonly MemoryEntry[]): string {
    if (!entries.length) return '';
    return `${PLATFORM_MEMORY_HEADING}\n\n${PLATFORM_MEMORY_NOTE}\n\n${entries.map(memoryLine).join('\n')}`;
}

/**
 * `system` with the block appended after everything stable (prompt caches
 * keep the prefix). Idempotent: a prompt already carrying the block is
 * returned as is; an empty block changes nothing.
 */
export function withMemoryBlock(system: string | undefined, block: string): string | undefined {
    if (!block) return system;
    const base = system?.trim() ?? '';
    if (base.includes(PLATFORM_MEMORY_HEADING)) return system;
    return base ? `${base}\n\n${block}` : block;
}

/** A turn's stop reason as a task outcome: limits end a turn, they do not fail the task. */
export function turnStatusOf(stopReason: string): TaskOutcome['status'] {
    switch (stopReason) {
        case 'end_turn':
        case 'max_tokens':
        case 'max_turns':
            return 'completed';
        case 'cancelled':
            return 'cancelled';
        default:
            return 'failed';
    }
}

/**
 * LRN-03: a result with text is a CLAIM of success; only a verification step
 * makes it `verified` (or `refuted`). Anything but a completion claims nothing.
 */
export function verificationOf(status: TaskOutcome['status'], result: TaskResult | undefined, verdict?: Verdict): TaskOutcome['verification'] {
    if (verdict) return verdict;
    if (result?.verified) return 'verified';
    if (status === 'completed' && result?.text?.trim()) return 'claimed';
    return 'none';
}

export interface TaskOutcomeInput {
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    readonly objective: string;
    readonly tags?: readonly string[];
    readonly status: TaskOutcome['status'];
    readonly result?: TaskResult;
    readonly verdict?: Verdict;
}

/** The `TaskOutcome` a learning plugin sees at the end of a task. */
export function taskOutcomeOf(input: TaskOutcomeInput): TaskOutcome {
    const result = input.result && input.verdict === 'verified' ? { ...input.result, verified: true } : input.result;
    return {
        taskId: input.taskId,
        agentId: input.agentId,
        status: input.status,
        ...(result ? { result } : {}),
        verification: verificationOf(input.status, result, input.verdict),
        objective: input.objective,
        tags: [...(input.tags ?? [])]
    };
}

export const CORRECTION_KINDS: readonly Correction['what'][] = ['wrong', 'prefer', 'never'];

export interface CorrectionInput {
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly what: Correction['what'];
    readonly by: Correction['by'];
    readonly at: number;
}

/** A well-formed `Correction`, or a `TypeError` naming what is wrong. */
export function correctionOf(input: CorrectionInput): Correction {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) throw new TypeError('a correction needs text');
    if (!CORRECTION_KINDS.includes(input.what)) throw new TypeError(`unknown correction kind "${String(input.what)}" (wrong | prefer | never)`);
    return { agentId: input.agentId, sessionId: input.sessionId, messageId: input.messageId, text, what: input.what, by: input.by, at: input.at };
}

/** The review-gated half of what a plugin proposed (LRN-08). */
export function instructionProposals(proposals: readonly Proposal[]): readonly InstructionProposal[] {
    return proposals.filter((p): p is InstructionProposal => p.kind === 'instruction');
}

export interface PlatformLearningPortsOptions {
    readonly plugin?: LearningPlugin | LearningPluginFactory;
    readonly retrieval?: RetrievalBudget;
    readonly verify?: LearningPorts['verify'];
    /** The build's memory plugins by id (#242) — the app's catalogue; the active one is picked per session. */
    readonly memoryPlugins?: LearningPorts['memoryPlugins'];
    /** The build's learning plugins by id (#242). */
    readonly learningPlugins?: LearningPorts['learningPlugins'];
}

/**
 * The platform's `LearningPorts`: memory is the Memory actor of each scope,
 * reached as the given principal (so `memoryAuthorize` and the shared-scope
 * ACL run for the AGENT, not for whoever opened the session), and instruction
 * proposals park on the Agent actor's review queue.
 */
export function platformLearningPorts(options: PlatformLearningPortsOptions = {}): LearningPorts {
    return {
        // `actorMemoryStore` only calls methods; a bound client is one minus `with`.
        memory: (scope, principal) => actorMemoryStore(actor(Memory, memoryActorKey(principal.workspaceId, scope)).with({ context: asPrincipal(principal) }) as MemoryActorClient),
        park: async (agent, proposals, origin, principal) => {
            await actor(AgentActor, agentKey(agent.workspaceId, agent.agentId))
                .with({ context: asPrincipal(principal) })
                .propose(proposals, origin);
        },
        ...(options.plugin ? { plugin: options.plugin } : {}),
        ...(options.retrieval ? { retrieval: options.retrieval } : {}),
        ...(options.verify ? { verify: options.verify } : {}),
        ...(options.memoryPlugins ? { memoryPlugins: options.memoryPlugins } : {}),
        ...(options.learningPlugins ? { learningPlugins: options.learningPlugins } : {})
    };
}
