/**
 * The Session actor — `{ws}:session:{id}` (architecture §4 Session, §5a, §5b).
 *
 * Durable by construction: every `AgentEvent` is appended as it happens
 * (`ctx.append`, folded by `applySessionEntry`), commands are idempotent by
 * `commandId` across activations, a late joiner replays the log with
 * `tail`, and a turn cut short by an eviction is closed as INTERRUPTED on
 * the next activation — never re-run (OPS-05/06).
 *
 * Two execution paths, one record:
 * - local: the `SessionFactory` opens an in-process `AgentSession`, served
 *   through `serveSession` for command validation and busy/closed
 *   semantics; the `drive` task pumps its events into the log one turn at
 *   a time and `resumeTasks` restarts it after an eviction.
 * - remote: a daemon serves the session; the Machine actor forwards its
 *   frames to `forwardFrames` and its replies to `commandReplied`.
 */

import { actorKey, type Correction, hasScope, type MessageId, type Principal, type Proposal, SESSION_EVENTS_TOPIC, type SessionEvent, type TaskError, type TaskResult, type UsageRow } from '@agentic/core';
import { defineActor, topic, type ActorContext, type ActorPolicy } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { createTranscript, reduceAgentEvent, toPromptParts, type AgentEvent, type AgentTranscript, type Decision, type EventCursor, type PromptInput, type UnstampedEvent } from '@sigx/ai-agent';
import { serveSession, WIRE_PROTOCOL_VERSION, type ServedSession, type WireCommand, type WireFrame, type WireOutputSpec, type WireReply } from '@sigx/ai-agent/wire';

import { mintAgentPrincipal, sameWorkspace } from '../auth/index.js';
import type { UsageVerdict } from '../ledger/recorder.js';
import { agentMemoryScope } from '../agent/agent.actor.js';
import type { InstructionProposal, ProposalOrigin } from '../agent/entries.js';
import { correctionOf, instructionProposals, lastUserText, learningPluginFor, renderMemoryBlock, retrieveMemories, taskOutcomeOf, turnStatusOf, withMemoryBlock, type LearningPorts } from '../task/driver.js';
import type { OpenedSession, SessionOpenSpec, SessionPorts } from './ports.js';
import { cursorAfter, eventsAfter, initialSessionState, parseSessionKey, type CorrectionRecord, type LearningRecord, type SessionEntry, type SessionPatch, type SessionState } from './state.js';
import { appendEntry, createTranscriptStore } from './store.js';

const V = WIRE_PROTOCOL_VERSION;

/** What a command returns: the served reply, or `pending` while a daemon has yet to answer. */
export type SessionCommandResult = WireReply | { readonly v: typeof V; readonly kind: 'pending'; readonly commandId: string };

/** `Session.get()` — the record without its log and transcript. */
export interface SessionInfo {
    readonly key: string;
    readonly opened: boolean;
    readonly spec?: SessionOpenSpec;
    readonly mode?: SessionState['mode'];
    readonly status: SessionState['status'];
    readonly head: EventCursor;
    readonly ref?: SessionState['ref'];
    readonly capabilities?: SessionState['capabilities'];
    readonly running?: SessionState['running'];
    readonly openRequests: readonly string[];
    readonly eventCount: number;
    /** The cursor the transcript snapshot stands at. */
    readonly transcriptAt?: EventCursor;
    readonly gap?: SessionState['gap'];
    readonly closedAt?: number;
    /** What the last finished turn taught (architecture §8), when the actor has learning ports. */
    readonly learning?: LearningRecord;
    /** Corrections made through `correct`, oldest first. */
    readonly corrections: readonly CorrectionRecord[];
}

/** What `correct` returns: the correction as the plugin saw it and what it proposed. */
export interface CorrectionResult {
    readonly correction: Correction;
    /** Every proposal, memory ones already applied by the plugin. */
    readonly proposals: readonly Proposal[];
    /** Instruction proposals parked on the Agent actor for review. */
    readonly parked: number;
}

/** The `error.code` an interrupted turn ends with; `error.data.interrupted` and `isInterruptedTurnEnd` name it exactly. */
export const INTERRUPTED_CODE = 'process_exited' as const;
export const INTERRUPTED_MESSAGE = 'interrupted: the session was evicted mid-turn; nothing was re-run';

/** The `turn-end` a resumed driver writes for a turn the eviction cut short. */
export function isInterruptedTurnEnd(ev: AgentEvent): boolean {
    return ev.type === 'turn-end' && ev.stopReason === 'error' && ev.error?.code === INTERRUPTED_CODE && ev.error.message === INTERRUPTED_MESSAGE;
}

/** After `sameWorkspace`: an external client needs the `sessions` scope. */
const sessionsScope: ActorPolicy = (principal: Principal | null) => !!principal && hasScope(principal, 'sessions');
/** The daemon path's entry points: only a machine principal (the Machine actor's socket) reaches them. */
const internalPolicy: ActorPolicy = (principal: Principal | null) => principal?.kind === 'machine';
/** A correction is a user's word — or an agent's, which the plugin drops unless configured to learn from it; never a machine's. */
const correctorPolicy: ActorPolicy = (principal: Principal | null) => principal !== null && principal.kind !== 'machine';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type SessionEventInit = DistributiveOmit<SessionEvent, 'agentId' | 'sessionId' | 'at'>;

interface Live extends OpenedSession {
    readonly served: ServedSession;
    /** Turns started on THIS runtime session — a `running` turn not in here belongs to an evicted activation. */
    readonly turns: Set<string>;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function newCommandId(type: string): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return `${type}:${out}`;
}

/**
 * Build the Session actor definition over its ports. One call per app —
 * the actor `type` is `'session'`, its wire and storage name.
 */
export function defineSessionActor(ports: SessionPorts) {
    const now = ports.now ?? Date.now;
    /** The live runtime session per activation, by actor key. Never outlives the activation that opened it. */
    const lives = new Map<string, Live>();

    async function dispose(key: string): Promise<void> {
        const live = lives.get(key);
        if (!live) return;
        lives.delete(key);
        await live.served.close().catch(() => {});
        await live.session.close().catch(() => {});
        await live.dispose?.().catch(() => {});
    }

    const set = (patch: SessionPatch): SessionEntry => ({ t: 'set', patch });

    function info(c: ActorContext<SessionState>): SessionInfo {
        const s = c.state;
        return {
            key: c.key,
            opened: s.opened,
            status: s.status,
            head: { epoch: s.head.epoch, seq: s.head.seq },
            openRequests: [...s.openRequests],
            eventCount: s.events.length,
            ...(s.spec ? { spec: c.snapshot(s.spec) } : {}),
            ...(s.mode ? { mode: s.mode } : {}),
            ...(s.ref ? { ref: c.snapshot(s.ref) } : {}),
            ...(s.capabilities ? { capabilities: c.snapshot(s.capabilities) } : {}),
            ...(s.running ? { running: c.snapshot(s.running) } : {}),
            ...(s.transcript ? { transcriptAt: { epoch: s.transcript.epoch, seq: s.transcript.seq } } : {}),
            ...(s.gap ? { gap: c.snapshot(s.gap) } : {}),
            ...(s.closedAt !== undefined ? { closedAt: s.closedAt } : {}),
            ...(s.learning ? { learning: c.snapshot(s.learning) } : {}),
            corrections: c.snapshot(s.corrections ?? [])
        };
    }

    /** The principal the session's memory and learning run as (MEM-11): the agent, whoever opened the session. */
    function agentPrincipal(c: ActorContext<SessionState>): Principal | null {
        const spec = c.state.spec;
        const parsed = parseSessionKey(c.key);
        if (!spec || !parsed) return null;
        return mintAgentPrincipal({ workspaceId: parsed.workspaceId, agentId: spec.agentId, sessionId: parsed.sessionId, ...(spec.taskId ? { taskId: spec.taskId } : {}) });
    }

    /**
     * Session start (architecture §8): query the agent's own scope and its shared
     * scopes as the agent, record what came back on the spec, and append the
     * platform-owned block to the system prompt. A scope that refuses is listed
     * in `retrieval.skipped`; a retrieval that fails altogether leaves the spec
     * without memories and says so — the session still opens.
     */
    async function withRetrievedMemory(c: ActorContext<SessionState>, spec: SessionOpenSpec, learning: LearningPorts): Promise<SessionOpenSpec> {
        const parsed = parseSessionKey(c.key);
        if (!parsed) return spec;
        const principal = mintAgentPrincipal({ workspaceId: parsed.workspaceId, agentId: spec.agentId, sessionId: parsed.sessionId, ...(spec.taskId ? { taskId: spec.taskId } : {}) });
        const at = now();
        try {
            const r = await retrieveMemories(learning.memory, principal, spec.config, spec, learning.retrieval);
            const system = withMemoryBlock(spec.system, renderMemoryBlock(r.entries));
            return {
                ...spec,
                memories: r.entries,
                retrieval: { text: r.text, scopes: r.scopes, skipped: r.skipped, at },
                ...(system !== undefined ? { system } : {})
            };
        } catch (error) {
            return { ...spec, memories: [], retrieval: { text: '', scopes: [], skipped: [{ scope: `agent:${spec.agentId}`, reason: error instanceof Error ? error.message : String(error) }], at } };
        }
    }

    /** The plugin for this session — built over the session's objective and tags when the port is a factory. */
    function pluginFor(c: ActorContext<SessionState>, learning: LearningPorts) {
        const spec = c.state.spec;
        const parsed = parseSessionKey(c.key);
        if (!spec || !parsed) return undefined;
        return learningPluginFor(learning.plugin, {
            workspaceId: parsed.workspaceId,
            agentId: spec.agentId,
            sessionId: parsed.sessionId,
            ...(spec.taskId ? { taskId: spec.taskId } : {}),
            ...(spec.objective ? { objective: spec.objective } : {}),
            ...(spec.tags ? { tags: spec.tags } : {})
        });
    }

    /** Instruction proposals go to the Agent actor's review queue (LRN-08); the parker is the app's, or the platform default. */
    async function park(c: ActorContext<SessionState>, learning: LearningPorts, instructions: readonly InstructionProposal[], origin: ProposalOrigin, principal: Principal): Promise<void> {
        if (!instructions.length || !learning.park) return;
        const spec = c.state.spec!;
        await learning.park({ workspaceId: principal.workspaceId, agentId: spec.agentId }, instructions, origin, principal);
    }

    /**
     * Turn end (architecture §7 "learning hook", §8): the turn's outcome — a
     * result with text is a CLAIM unless `verify` says otherwise (LRN-03) —
     * goes to `onTaskEnd`; memory proposals are applied by the plugin,
     * instruction proposals parked. Runs only for a task session's regular
     * turn end: an interrupted turn is not an outcome, and a session without a
     * task has no task to record. Failure is recorded, never thrown.
     */
    async function learnFromTurn(c: ActorContext<SessionState>, turnId: string, text: string): Promise<void> {
        const learning = ports.learning;
        const s = c.state;
        const spec = s.spec;
        const parsed = parseSessionKey(c.key);
        const principal = agentPrincipal(c);
        const plugin = learning && pluginFor(c, learning);
        if (!learning || !plugin || !spec?.taskId || !parsed || !principal) return;
        const end = s.events.findLast((e) => e.type === 'turn-end' && e.turnId === turnId);
        if (!end || end.type !== 'turn-end' || isInterruptedTurnEnd(end)) return;
        const status = turnStatusOf(end.stopReason);
        const result: TaskResult = { ...(text ? { text } : {}), artifacts: [], verified: false };
        const start = s.events.find((e) => e.type === 'turn-start' && e.turnId === turnId);
        const objective = spec.objective?.trim() || (start?.type === 'turn-start' ? lastUserText(start.input) : '');
        let record: LearningRecord = { turnId, at: now(), status, verification: 'none', written: 0, parked: 0 };
        try {
            const verdict = await learning.verify?.({ taskId: spec.taskId, agentId: spec.agentId, turnId, status, result });
            const outcome = taskOutcomeOf({ taskId: spec.taskId, agentId: spec.agentId, objective, tags: spec.tags ?? [], status, result, ...(verdict ? { verdict } : {}) });
            record = { ...record, verification: outcome.verification };
            const proposals = await plugin.onTaskEnd(outcome, learning.memory(agentMemoryScope(spec.agentId), principal));
            const instructions = instructionProposals(proposals);
            await park(c, learning, instructions, { kind: 'task-end', sessionId: parsed.sessionId, taskId: spec.taskId }, principal);
            record = { ...record, written: proposals.length - instructions.length, parked: instructions.length };
        } catch (error) {
            record = { ...record, error: error instanceof Error ? error.message : String(error) };
        }
        s.learning = record;
    }

    /** Best-effort publish to the chat this session belongs to (CHT-11): a subscriber's failure lands in the report, never here. */
    async function publishChat(c: ActorContext<SessionState>, event: SessionEventInit): Promise<void> {
        const spec = c.state.spec;
        const parsed = parseSessionKey(c.key);
        if (!spec?.chatId || !parsed) return;
        const payload = { ...event, agentId: spec.agentId, sessionId: parsed.sessionId, at: now() } as SessionEvent;
        try {
            await c.publish(topic<SessionEvent>(SESSION_EVENTS_TOPIC, actorKey(parsed.workspaceId, 'chat', spec.chatId)), payload);
        } catch {
            // A chat that cannot be reached never fails the session.
        }
    }

    /** Fold the events since the last snapshot into a detached copy of it; the transcript itself says where it stands. */
    function snapshotTranscript(c: ActorContext<SessionState>): AgentTranscript {
        const s = c.state;
        const last = s.events[s.events.length - 1];
        const base = s.transcript ? c.snapshot(s.transcript) : createTranscript(last?.sessionId ?? s.ref?.id ?? '');
        for (const ev of c.snapshot(eventsAfter(s.events, { epoch: base.epoch, seq: base.seq }))) reduceAgentEvent(base, ev);
        return base;
    }

    /** The final assistant text of one turn (sub-agent output stays nested under its call). */
    function finalText(transcript: AgentTranscript, turnId: string): string {
        let text = '';
        for (const m of transcript.messages) {
            if (m.role !== 'assistant' || m.turnId !== turnId || m.parentCallId) continue;
            for (const p of m.parts) if (p.type === 'text' && p.text) text += (text ? '\n' : '') + p.text;
        }
        return text;
    }

    /** Pull what the session has already buffered (the `state` after a turn, a `config` after `configure()`) without waiting for more. */
    async function drainBuffered(c: ActorContext<SessionState>, live: Live): Promise<void> {
        let source: AsyncIterable<AgentEvent>;
        try {
            source = live.session.subscribe({ epoch: c.state.head.epoch, seq: c.state.head.seq });
        } catch {
            return; // the head is older than the buffer keeps: nothing to fill from here
        }
        const it = source[Symbol.asyncIterator]();
        const tick = () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 0));
        try {
            for (;;) {
                const next = await Promise.race([it.next(), tick()]);
                if (!next || next.done) return;
                await appendEntry(c, { t: 'ev', ev: next.value } satisfies SessionEntry);
                await recordUsage(c, next.value); // the turn is over: the books get the row, the verdict has nothing left to stop
            }
        } finally {
            await it.return?.();
        }
    }

    /**
     * After a turn-scoped `usage` event is durable: price it (the runtime's
     * `usageRow`, else the event's own cost as reported, else unpriced), hand
     * it to the recorder (Ledger + Task budget, OPS-07/08) and return the
     * verdict. Session-scoped events are cumulative totals and never counted.
     * The books never fail a turn: a recorder that throws is a `null` verdict.
     */
    async function recordUsage(c: ActorContext<SessionState>, ev: AgentEvent): Promise<UsageVerdict | null> {
        if (ev.type !== 'usage' || ev.scope !== 'turn' || !ports.usage) return null;
        const spec = c.state.spec;
        const parsed = parseSessionKey(c.key);
        if (!spec || !parsed) return null;
        const at = { sessionId: parsed.sessionId, ...(spec.taskId !== undefined ? { taskId: spec.taskId } : {}), at: now() };
        const live = lives.get(c.key);
        try {
            // `@sigx/ai` leaves the counters optional (and an adapter may omit `usage`); a ledger row always carries both.
            const reported = (ev.usage ?? {}) as Partial<UsageRow['usage']>;
            const usage = { ...reported, inputTokens: reported.inputTokens ?? 0, outputTokens: reported.outputTokens ?? 0 };
            const event = { usage, ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}) };
            const priced: UsageRow = live?.usageRow ? live.usageRow(event, at) : { ...at, ...event, agentId: spec.agentId, estimated: false };
            const row = { ...priced, agentId: spec.agentId, sessionId: parsed.sessionId, key: `${ev.sessionId}:${ev.epoch}:${ev.seq}`, ...(ev.turnId !== undefined ? { turnId: ev.turnId } : {}) };
            return await ports.usage.record(c, parsed.workspaceId, row);
        } catch {
            return null; // a pricer or recorder that throws never fails the turn
        }
    }

    /** The budget is spent (OPS-08): cancel the running turn on the live session and record the exchange. */
    async function cancelLocal(c: ActorContext<SessionState>, live: Live, error: TaskError): Promise<void> {
        const command: WireCommand = { v: V, commandId: newCommandId('cancel'), type: 'cancel' };
        const reply = await live.served.handleCommand(command);
        await appendEntry(c, { t: 'reply', command, reply, at: now() } satisfies SessionEntry);
        await publishChat(c, { kind: 'status', status: 'task', ref: `${error.code}:${error.message}` });
    }

    /** Turn end, both paths: snapshot the transcript, refresh the ref, tell the chat, compact. */
    async function finishTurn(c: ActorContext<SessionState>, turnId: string): Promise<void> {
        const s = c.state;
        const live = lives.get(c.key);
        if (live) await drainBuffered(c, live);
        const transcript = snapshotTranscript(c);
        s.transcript = transcript;
        if (live) s.ref = structuredClone(live.session.ref);
        const text = finalText(transcript, turnId);
        if (text) await publishChat(c, { kind: 'message', parts: [{ type: 'text', text }], ...(s.spec?.taskId ? { taskId: s.spec.taskId } : {}) });
        await learnFromTurn(c, turnId, text);
        await c.save();
    }

    /**
     * A turn the eviction cut short: close what is open (calls, requests),
     * end the turn with the interrupted error and settle the session state
     * — stamped in the epoch the events were in, gapless after the head.
     */
    async function finishInterrupted(c: ActorContext<SessionState>, turnId: string): Promise<void> {
        const s = c.state;
        const run = s.running;
        if (!run || run.turnId !== turnId) return;
        const input = c.snapshot(run.input);
        const last = s.events[s.events.length - 1];
        const sessionId = last?.sessionId ?? s.ref?.id ?? parseSessionKey(c.key)?.sessionId ?? c.key;
        const epoch = Math.max(1, s.head.epoch);
        let seq = s.head.epoch === 0 ? 0 : s.head.seq;
        const emit = (payload: UnstampedEvent) => appendEntry(c, { t: 'ev', ev: { ...payload, sessionId, epoch, seq: ++seq } } satisfies SessionEntry);
        const before = snapshotTranscript(c);
        if (!s.events.some((e) => e.turnId === turnId && e.type === 'turn-start')) await emit({ type: 'turn-start', turnId, input });
        for (const m of before.messages) {
            if (m.turnId !== turnId) continue;
            for (const p of m.parts) {
                if (p.type === 'tool' && (p.status === 'pending' || p.status === 'in_progress')) {
                    await emit({ type: 'tool-update', turnId, ...(m.parentCallId ? { parentCallId: m.parentCallId } : {}), callId: p.callId, status: 'cancelled', error: INTERRUPTED_MESSAGE });
                }
            }
        }
        for (const r of Object.values(before.requests)) {
            if (r.turnId !== turnId) continue;
            await emit({ type: 'request-resolved', turnId, requestId: r.requestId, outcome: 'cancel', by: 'cancel', reason: INTERRUPTED_MESSAGE, at: now() });
        }
        await emit({ type: 'error', turnId, code: INTERRUPTED_CODE, message: INTERRUPTED_MESSAGE, recoverable: true, data: { interrupted: true } });
        // The session settles before the turn closes, so the `turn-end` is the last word — what a resumer reads first.
        if (s.status !== 'closed') await emit({ type: 'state', value: 'idle' });
        await emit({ type: 'turn-end', turnId, stopReason: 'error', error: { code: INTERRUPTED_CODE, message: INTERRUPTED_MESSAGE } });
        await finishTurn(c, turnId);
        await publishChat(c, { kind: 'status', status: 'task', ref: `interrupted:${turnId}` });
    }

    return defineActor({
        type: 'session',
        authorize: [sameWorkspace, sessionsScope],
        methodAuthorize: { forwardFrames: internalPolicy, commandReplied: internalPolicy, correct: correctorPolicy },
        state: (): SessionState => initialSessionState(),
        onDeactivate: (ctx) => dispose(ctx.key),
        methods: (ctx) => {
            // A fresh activation starts with no live session — whatever a previous one left here is stale.
            void dispose(ctx.key);

            const parsed = parseSessionKey(ctx.key);

            /** The daemon path's in-turn check: only the machine this remote session was opened on may speak for it. */
            function assertHostingMachine(): void {
                const p = ctx.principal as Principal | null;
                const s = ctx.state;
                if (!s.opened || s.mode !== 'remote' || !s.spec?.machineId || p?.kind !== 'machine' || p.machineId !== s.spec.machineId) {
                    throw new ServerFnError(403, `session: "${ctx.key}" is not hosted by this machine`);
                }
            }

            async function ensureLive(): Promise<Live | null> {
                const existing = lives.get(ctx.key);
                if (existing) return existing;
                const s = ctx.state;
                if (!s.opened || !s.spec || s.mode === 'remote' || !parsed) return null;
                const spec = ctx.snapshot(s.spec);
                const resume = s.ref ? ctx.snapshot(s.ref) : spec.resume;
                const opened = await ports.factory(spec.runtime, {
                    key: ctx.key,
                    workspaceId: parsed.workspaceId,
                    sessionId: parsed.sessionId,
                    spec,
                    ...(resume ? { resume } : {}),
                    signal: ctx.abortSignal,
                    transcripts: createTranscriptStore(ctx)
                });
                if (!opened) {
                    await appendEntry(ctx, set({ mode: 'remote' }));
                    return null;
                }
                const served = serveSession(opened.session, { agentId: opened.agentId, capabilities: opened.capabilities });
                const live: Live = { ...opened, served, turns: new Set() };
                lives.set(ctx.key, live);
                await appendEntry(ctx, set({ mode: 'local', ref: structuredClone(opened.session.ref), capabilities: structuredClone(opened.capabilities) }));
                return live;
            }

            const errorReply = (commandId: string, code: Extract<WireReply, { kind: 'error' }>['code'], message: string): WireReply => ({ v: V, kind: 'error', commandId, code, message });
            const pending = (commandId: string): SessionCommandResult => ({ v: V, kind: 'pending', commandId });

            /** Apply a reply: remember it, start the driver on a prompt ack, settle on a close ack. */
            async function recordReply(command: WireCommand, replied: WireReply): Promise<void> {
                const s = ctx.state;
                const at = now();
                if (command.type === 'prompt' && replied.kind === 'ack') {
                    const turnId = replied.turnId ?? command.turnId;
                    // A steered prompt joined the running turn: nothing new to drive.
                    const starts = !s.running;
                    if (starts) await appendEntry(ctx, set({ running: { turnId, commandId: command.commandId, input: command.input, startedAt: at }, status: 'running' }));
                    await appendEntry(ctx, { t: 'reply', command, reply: replied, at } satisfies SessionEntry);
                    if (starts && s.mode === 'local') {
                        lives.get(ctx.key)?.turns.add(turnId);
                        await ctx.tasks.start('drive', { turnId });
                    }
                    if (starts) await publishChat(ctx, { kind: 'status', status: 'typing', ref: turnId });
                    return;
                }
                await appendEntry(ctx, { t: 'reply', command, reply: replied, at } satisfies SessionEntry);
                if (command.type === 'close' && replied.kind === 'ack') {
                    const live = lives.get(ctx.key);
                    if (live) await drainBuffered(ctx, live);
                    await dispose(ctx.key);
                    await appendEntry(ctx, set({ status: 'closed', closedAt: at }));
                    if (s.running) {
                        // Closed mid-turn: the turn ends here, and the record says so.
                        await finishInterrupted(ctx, s.running.turnId);
                    } else {
                        s.transcript = snapshotTranscript(ctx);
                        await ctx.save();
                    }
                    await publishChat(ctx, { kind: 'status', status: 'session-ended' });
                    return;
                }
                if (command.type === 'configure' && replied.kind === 'ack') {
                    const live = lives.get(ctx.key);
                    if (live) await drainBuffered(ctx, live);
                }
            }

            /** Idempotent by `commandId`: a known command answers with what it answered before, or `pending`. */
            async function dispatch(command: WireCommand): Promise<SessionCommandResult> {
                const s = ctx.state;
                const known = s.commands[command.commandId];
                if (known) return known.reply ? ctx.snapshot(known.reply) : pending(command.commandId);
                if (s.status === 'closed') return errorReply(command.commandId, 'closed', `session "${ctx.key}" is closed`);
                if (!s.opened) return errorReply(command.commandId, 'invalid', `session "${ctx.key}" is not open`);
                const live = await ensureLive();
                // A local turn no live session knows was cut short by an eviction: settle it before anything else runs.
                if (s.running && s.mode === 'local' && !live?.turns.has(s.running.turnId)) await finishInterrupted(ctx, s.running.turnId);
                if (live) {
                    const replied = await live.served.handleCommand(command, ctx.principal);
                    await recordReply(command, replied);
                    return structuredClone(replied);
                }
                const machineId = s.spec?.machineId;
                if (!machineId || !ports.commands || !parsed) {
                    return errorReply(command.commandId, 'unsupported', `session "${ctx.key}" has no live runtime session and no machine to send "${command.type}" to`);
                }
                await appendEntry(ctx, { t: 'command', command, at: now() } satisfies SessionEntry);
                await ports.commands.send({ workspaceId: parsed.workspaceId, machineId, sessionId: parsed.sessionId }, command);
                return pending(command.commandId);
            }

            return {
                /** Record the spec and open the runtime session. Idempotent: a second call returns the record. */
                async open(spec: SessionOpenSpec): Promise<SessionInfo> {
                    const s = ctx.state;
                    if (s.status === 'closed') throw new Error(`session "${ctx.key}" is closed`);
                    const first = !s.opened;
                    if (first) {
                        // Memory is retrieved before the runtime session exists, so the factory (and a daemon) sees the block in the spec.
                        const recorded = ports.learning ? await withRetrievedMemory(ctx, structuredClone(spec), ports.learning) : structuredClone(spec);
                        await appendEntry(ctx, set({ opened: true, spec: recorded, status: 'idle', ...(spec.resume ? { ref: spec.resume } : {}), ...(spec.machineId ? { mode: 'remote' } : {}) }));
                    }
                    await ensureLive();
                    if (first) await publishChat(ctx, { kind: 'status', status: 'session-started' });
                    return info(ctx);
                },

                /** Run a turn. `commandId` defaults to `turnId`, so a retried prompt executes once (OPS-06). */
                prompt(input: PromptInput, turnId: string, output?: WireOutputSpec, commandId: string = turnId): Promise<SessionCommandResult> {
                    return dispatch({ v: V, commandId, type: 'prompt', turnId, input: toPromptParts(input), ...(output ? { output } : {}) });
                },

                /** Answer an open request (CHT-09). One decision per request: `commandId` defaults to `respond:{requestId}`. */
                respond(requestId: string, decision: Decision, commandId: string = `respond:${requestId}`): Promise<SessionCommandResult> {
                    return dispatch({ v: V, commandId, type: 'respond', requestId, decision });
                },

                /** Cancel the running turn, or one sub-agent. */
                cancel(agentId?: string, commandId: string = newCommandId('cancel')): Promise<SessionCommandResult> {
                    return dispatch({ v: V, commandId, type: 'cancel', ...(agentId ? { agentId } : {}) });
                },

                configure(patch: Readonly<Record<string, string>>, commandId: string = newCommandId('configure')): Promise<SessionCommandResult> {
                    return dispatch({ v: V, commandId, type: 'configure', patch });
                },

                /** Close the runtime session and freeze the record. */
                async close(commandId: string = newCommandId('close')): Promise<SessionCommandResult> {
                    const s = ctx.state;
                    if (s.status === 'closed') return { v: V, kind: 'ack', commandId };
                    const command: WireCommand = { v: V, commandId, type: 'close' };
                    const result = await dispatch(command);
                    if (result.kind === 'error' && result.code === 'unsupported') {
                        // Nothing live and nowhere to send it: close the record itself.
                        const ack: WireReply = { v: V, kind: 'ack', commandId };
                        await recordReply(command, ack);
                        return ack;
                    }
                    return result;
                },

                get(): SessionInfo {
                    return info(ctx);
                },

                /** Events after `from` (exclusive) — a one-shot read; `tail` follows. */
                events(from?: EventCursor): AgentEvent[] {
                    return ctx.snapshot(eventsAfter(ctx.state.events, from));
                },

                /** The transcript snapshot from the last turn end, if any. */
                transcript(): AgentTranscript | undefined {
                    const t = ctx.state.transcript;
                    return t ? ctx.snapshot(t) : undefined;
                },

                /**
                 * "Correct" on an assistant message (architecture §8, AC-09): the
                 * correction goes to `onCorrection` as the agent, so the lesson lands
                 * in the agent's own scope with the user's provenance; instruction
                 * proposals are parked for review. `what`: `wrong` (this was wrong),
                 * `prefer` (do it this way), `never` (never do this).
                 */
                async correct(messageId: MessageId, text: string, what: Correction['what']): Promise<CorrectionResult> {
                    const learning = ports.learning;
                    const s = ctx.state;
                    const principal = agentPrincipal(ctx);
                    if (!learning?.plugin) throw new Error(`session "${ctx.key}": no learning plugin is configured, corrections cannot be learned from`);
                    if (!s.opened || !s.spec || !parsed || !principal) throw new Error(`session "${ctx.key}" is not open`);
                    const plugin = pluginFor(ctx, learning)!;
                    const message = snapshotTranscript(ctx).messages.find((m) => m.id === messageId);
                    if (!message || message.role !== 'assistant') throw new Error(`session "${ctx.key}": "${messageId}" is not an assistant message of this session`);
                    const caller = ctx.principal as Principal | null;
                    const correction = correctionOf({
                        agentId: s.spec.agentId,
                        sessionId: parsed.sessionId,
                        messageId,
                        text,
                        what,
                        by: caller?.kind === 'agent' ? 'agent' : 'user',
                        at: now()
                    });
                    const proposals = await plugin.onCorrection(correction, learning.memory(agentMemoryScope(s.spec.agentId), principal));
                    const instructions = instructionProposals(proposals);
                    await park(ctx, learning, instructions, { kind: 'correction', sessionId: parsed.sessionId, messageId, ...(s.spec.taskId ? { taskId: s.spec.taskId } : {}) }, principal);
                    const record: CorrectionRecord = { messageId, what: correction.what, by: correction.by, at: correction.at, written: proposals.length - instructions.length, parked: instructions.length };
                    await appendEntry(ctx, set({ corrections: [...(s.corrections ?? []), record] }));
                    return { correction, proposals: ctx.snapshot(proposals), parked: instructions.length };
                },

                /** Daemon path (internal): frames from the machine's socket, one-way. */
                async forwardFrames(frames: readonly WireFrame[]): Promise<void> {
                    assertHostingMachine();
                    const s = ctx.state;
                    for (const frame of frames) {
                        switch (frame.kind) {
                            case 'hello':
                                await appendEntry(ctx, set({ mode: 'remote', ref: frame.sessionRef, capabilities: frame.capabilities, ...(s.status === 'disconnected' ? { status: 'idle' as const } : {}) }));
                                break;
                            case 'event': {
                                const runningTurn = s.running?.turnId;
                                await appendEntry(ctx, { t: 'ev', ev: frame.event } satisfies SessionEntry);
                                const verdict = await recordUsage(ctx, frame.event);
                                // Over budget on the daemon path: the cancel travels the CommandSink like any other command.
                                if (verdict && !verdict.ok && s.running) await dispatch({ v: V, commandId: newCommandId('cancel'), type: 'cancel' });
                                if (frame.event.type === 'turn-end' && runningTurn !== undefined && runningTurn === frame.event.turnId) await finishTurn(ctx, runningTurn);
                                break;
                            }
                            case 'gap':
                                await appendEntry(ctx, set({ gap: { from: frame.from, resumeAt: frame.resumeAt, at: now() }, status: 'disconnected', head: frame.resumeAt }));
                                break;
                        }
                    }
                },

                /** Daemon path (internal): the reply to a command sent through the `CommandSink`. */
                async commandReplied(replied: WireReply): Promise<void> {
                    assertHostingMachine();
                    const known = ctx.state.commands[replied.commandId];
                    if (!known || known.reply) return;
                    await recordReply(ctx.snapshot(known.command), replied);
                }
            };
        },
        streams: (ctx) => ({
            /** Replay from `from` (exclusive; `{ epoch: 0, seq: 0 }` for everything), then follow until the session closes. */
            async *tail(from?: EventCursor): AsyncIterable<AgentEvent> {
                let last: EventCursor = from ?? { epoch: 0, seq: 0 };
                for await (const s of ctx.changes({ initial: true })) {
                    for (const ev of eventsAfter(s.events, last)) {
                        if (!cursorAfter(last, ev)) continue;
                        last = { epoch: ev.epoch, seq: ev.seq };
                        yield ev;
                    }
                    if (s.status === 'closed') return;
                }
            }
        }),
        tasks: (ctx) => ({
            /**
             * Pump one turn's events into the log. Restarted by the runtime's
             * task ledger after an eviction: with no live session to follow,
             * the turn is closed as interrupted — a model call is never replayed.
             */
            async drive(input: { readonly turnId: string }): Promise<void> {
                const { turnId } = input;
                const snap = ctx.snapshot();
                if (!snap.running || snap.running.turnId !== turnId) return;
                const live = lives.get(ctx.key);
                if (!live || !live.turns.has(turnId)) {
                    await ctx.turn((c) => finishInterrupted(c, turnId));
                    return;
                }
                const signal = ctx.abortSignal;
                let source: AsyncIterable<AgentEvent>;
                try {
                    source = live.session.subscribe(snap.head);
                } catch {
                    source = live.session.subscribe();
                }
                const it = source[Symbol.asyncIterator]();
                const aborted = new Promise<IteratorResult<AgentEvent>>((resolve) => {
                    const done = () => resolve({ value: undefined as never, done: true });
                    if (signal.aborted) done();
                    else signal.addEventListener('abort', done, { once: true });
                });
                let ended = false;
                try {
                    for (;;) {
                        const next = await Promise.race([it.next(), aborted]);
                        // Deactivating: leave `running` in place — the next activation closes the turn as interrupted.
                        if (signal.aborted || next.done) return;
                        const ev = next.value;
                        await ctx.turn((c) => appendEntry(c, { t: 'ev', ev } satisfies SessionEntry));
                        const verdict = await ctx.turn((c) => recordUsage(c, ev));
                        // Over budget: the task has already failed itself; the turn stops here and no child starts (COL-11, OPS-08).
                        if (verdict && !verdict.ok && !signal.aborted) await ctx.turn((c) => cancelLocal(c, live, verdict.error));
                        if (ev.type === 'turn-end' && ev.turnId === turnId) {
                            ended = true;
                            break;
                        }
                    }
                } catch {
                    // The subscription failed (a dropped slow subscriber): the turn is over as far as the record can tell.
                    if (signal.aborted) return;
                    await ctx.turn((c) => finishInterrupted(c, turnId));
                    return;
                } finally {
                    await it.return?.();
                }
                if (ended) await ctx.turn((c) => finishTurn(c, turnId));
            }
        })
    });
}

export type SessionActor = ReturnType<typeof defineSessionActor>;
