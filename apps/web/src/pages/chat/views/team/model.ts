/**
 * The Team view's rows, read off the one `ChatViewModel` (#1059, CHT-09, COL-09;
 * `docs/design/chat-modes/HANDOFF.md` → "Team"). Pure:
 *
 * - **Handoffs**: one per `delegate` step of an agent's finished turn (`msg.steps`, #1055) — who, to whom,
 *   the task text and the item ref — placed at the turn's time.
 * - **Work cards**: one per agent per assignment. An agent at work now (`view.live`) has a working card after
 *   every row, its steps read off its feed's turn in flight (live) or its current step (mock); the feed's
 *   in-flight rows fold into it. An assignment handed off earlier and answered since has a done card in
 *   place of the answer, whose prose becomes the card's result.
 * - **Folded talk**: a run of agent-to-agent messages (`audienceOf` over the `@` names in the text) folds into
 *   one divider; an opened run shows its messages again.
 * - **Questions**: each open input request with no tool call of its own, under its asker's last row, with
 *   the ref of the asker's assignment (`blocks #23`).
 * - **Crew**: one chip per member — working, waiting on you, done, failed or idle — with its step, elapsed
 *   time or question.
 */
import type { AgentMessage, AgentTranscript, OpenRequest } from '@sigx/ai-agent/app';
import { audienceOf, type AgentId, type ChatEntry, type TranscriptStep } from '@agentic/core';
import { looseRequests, stepsFromToolParts, type CrewMember, type CrewState, type StepsMessage, type TeamAgent } from '@agentic/ui';
import { inFlightMessages, mentionsIn } from '../../live';
import type { ChatViewModel, LiveWork } from '../types';

/** Placed after every message (an in-flight row counts as later than any finite time). */
const AFTER_ALL = Number.POSITIVE_INFINITY;

export interface TeamHandoff {
    readonly key: string;
    readonly at: number;
    readonly from: string;
    readonly to: string;
    /** What was handed off: the step's target, less a leading `<to> · `. */
    readonly task: string;
    /** `#21`: the plan item, else the task id; absent when the step names neither. */
    readonly itemRef?: string;
    readonly taskId?: string;
}

export interface TeamWork {
    /** The assignment: its task id when known, else the handoff, else the agent. */
    readonly key: string;
    readonly agentId: string;
    readonly state: CrewState;
    /** `Real register build · #21`. */
    readonly task: string;
    readonly steps: readonly TranscriptStep[];
    readonly stepCount: number;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly result?: string;
    readonly at: number;
    /** The answer the card stands in for. */
    readonly messageId?: string;
}

export interface TeamTalk {
    /** The run's first message id. */
    readonly key: string;
    readonly messageIds: readonly string[];
    /** Who talked, in order of first message. */
    readonly names: readonly string[];
    /** Where the folded divider sits: after the run's last message. */
    readonly at: number;
    /** Where the open divider sits: before the run's first message. */
    readonly openAt: number;
}

export interface TeamQuestion {
    readonly request: OpenRequest;
    readonly agentId?: string;
    /** `#23`: the asker's assignment. */
    readonly blocks?: string;
    readonly at: number;
}

export interface TeamRows {
    /** The messages the thread still shows as rows. */
    readonly messages: readonly AgentMessage[];
    readonly handoffs: readonly TeamHandoff[];
    readonly work: readonly TeamWork[];
    readonly talk: readonly TeamTalk[];
    readonly questions: readonly TeamQuestion[];
    readonly crew: readonly CrewMember[];
}

/** A message's time from what the page says of its author; `undefined` for an in-flight row. */
function timeOf(view: ChatViewModel, m: AgentMessage): number | undefined {
    const iso = view.thread.describe?.(m)?.time?.dateTime;
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(t) ? undefined : t;
}

const textOf = (m: AgentMessage): string =>
    m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n').trim();

/** A ref as the chip prints it: `#21`. */
const refOf = (item: string): string => (item.startsWith('#') ? item : /^\d+$/.test(item) ? `#${item}` : item);

/** The task text of a delegate step: its target, less a leading `<to> · ` (the name or the id). */
function taskText(step: TranscriptStep, toName: string, to: string): string {
    const target = step.target.trim();
    for (const who of [toName, to]) {
        if (target === who) return '';
        const prefix = `${who} · `;
        if (target.startsWith(prefix)) return target.slice(prefix.length);
    }
    return target;
}

/** `Real register build · #21`: the task, then its ref; `Working` with neither. */
function assignmentText(h: TeamHandoff | undefined): string {
    if (!h) return 'Working';
    const parts = [h.task, h.itemRef].filter((x): x is string => !!x);
    return parts.length ? parts.join(' · ') : 'Working';
}

/** The handoffs in the finished turns, oldest first. */
export function handoffsOf(view: ChatViewModel, messages: readonly AgentMessage[]): TeamHandoff[] {
    const out: TeamHandoff[] = [];
    for (const m of messages) {
        const steps = (m as StepsMessage).steps?.steps;
        if (m.role !== 'assistant' || !steps) continue;
        const at = timeOf(view, m) ?? AFTER_ALL;
        for (const step of steps) {
            if (step.kind !== 'delegate' || !step.delegate) continue;
            const to = step.delegate.to as string;
            const ref = step.delegate.item ? refOf(step.delegate.item) : step.delegate.taskId;
            out.push({
                key: step.id,
                at,
                from: (m.actor ?? step.agentId) as string,
                to,
                task: taskText(step, view.lookup(to).name, to),
                ...(ref ? { itemRef: ref } : {}),
                ...(step.delegate.taskId ? { taskId: step.delegate.taskId } : {})
            });
        }
    }
    return out;
}

/** Who a message is for, by the `@` names in its text (`audienceOf`). */
export function audienceOfMessage(m: AgentMessage, view: ChatViewModel): 'people' | string {
    if (m.role !== 'assistant' || !m.actor) return 'people';
    const entry = { t: 'msg', author: { kind: 'agent', agentId: m.actor }, mentions: mentionsIn(textOf(m), view.members, view.lookup) } as unknown as ChatEntry;
    return audienceOf(entry, view.members.map((x) => x.agentId as AgentId));
}

/** `Bash · npx sigx zero:build` as a running step, for a live line that carries only its text (mock). */
function stepOfLine(w: LiveWork): TranscriptStep {
    const [tool, ...rest] = (w.step ?? '').split(' · ');
    return { id: `live:${w.agentId}`, turnId: `live:${w.agentId}`, agentId: w.agentId as AgentId, kind: 'other', tool: tool ?? '', target: rest.join(' · '), state: 'running' };
}

/** The ids of messages with an approval or question open on one of their calls: they stay rows. */
function withOpenCall(transcript: AgentTranscript): Set<string> {
    const calls = new Set(Object.values(transcript.requests).flatMap((r) => (r.callId ? [r.callId] : [])));
    const out = new Set<string>();
    if (!calls.size) return out;
    for (const m of transcript.messages) if (m.parts.some((p) => p.type === 'tool' && calls.has(p.callId))) out.add(m.id);
    return out;
}

/** Who asked an open request: the feed holding it, else the requester the page names, else the member waiting on you. */
function askerOf(view: ChatViewModel, r: OpenRequest): string | undefined {
    const feed = view.feeds.find((f) => f.transcript.requests[r.requestId]);
    if (feed) return feed.agentId;
    const name = view.thread.describeRequest?.(r)?.requestedBy?.name;
    const named = name ? view.members.find((m) => view.lookup(m.agentId).name === name) : undefined;
    if (named) return named.agentId;
    return view.members.find((m) => m.status === 'waiting')?.agentId;
}

const names = (ids: readonly string[], view: ChatViewModel): string =>
    ids.length <= 1 ? ids.map((id) => view.lookup(id).name).join('') : `${ids.slice(0, -1).map((id) => view.lookup(id).name).join(', ')} and ${view.lookup(ids[ids.length - 1]!).name}`;

/**
 * The Team rows. `open` names the talk runs (by first message id) the viewer opened.
 */
export function teamRows(view: ChatViewModel, open: ReadonlySet<string> = new Set()): TeamRows {
    const transcript = view.thread.transcript;
    const all = transcript.messages;
    const hidden = new Set<string>();
    const keep = withOpenCall(transcript);
    const liveBy = new Map(view.live.map((w) => [w.agentId, w]));

    const handoffs = handoffsOf(view, all);
    const lastHandoff = (agentId: string): TeamHandoff | undefined => [...handoffs].reverse().find((h) => h.to === agentId);

    const questions: TeamQuestion[] = [];
    const askers = new Set<string>();
    if (view.thread.onRespond) {
        for (const r of looseRequests(transcript)) {
            if (r.kind !== 'input') continue;
            const agentId = askerOf(view, r);
            if (agentId) askers.add(agentId);
            const h = agentId ? lastHandoff(agentId) : undefined;
            const last = agentId ? [...all].reverse().find((m) => m.role === 'assistant' && m.actor === agentId && !hidden.has(m.id)) : undefined;
            // Mid-turn, it sits under the asker's rows in flight; else under its last answer.
            const at = last && !liveBy.has(agentId!) ? timeOf(view, last) ?? AFTER_ALL : AFTER_ALL;
            questions.push({ request: r, ...(agentId ? { agentId } : {}), ...(h?.itemRef ? { blocks: h.itemRef } : {}), at });
        }
    }

    // The turns in flight fold into their agent's working card (one asking you keeps its rows, its question under them).
    const flight = new Map<string, AgentMessage[]>();
    for (const feed of view.feeds) {
        const rows = inFlightMessages(feed.transcript);
        flight.set(feed.agentId, [...(flight.get(feed.agentId) ?? []), ...rows]);
        if (liveBy.has(feed.agentId) && !askers.has(feed.agentId)) for (const m of rows) if (!keep.has(m.id)) hidden.add(m.id);
    }

    // Done cards: an assignment answered since its handoff — the agent's last message to people before its next handoff.
    const work: TeamWork[] = [];
    handoffs.forEach((h, i) => {
        const next = handoffs.slice(i + 1).find((x) => x.to === h.to);
        const latest = !next;
        if (latest && (liveBy.has(h.to) || askers.has(h.to))) return;
        const answer = [...all].reverse().find((m) => {
            if (m.role !== 'assistant' || m.actor !== h.to || hidden.has(m.id) || keep.has(m.id)) return false;
            const at = timeOf(view, m);
            if (at === undefined || at < h.at || (next && at >= next.at)) return false;
            return audienceOfMessage(m, view) === 'people';
        });
        if (!answer) return;
        const steps = (answer as StepsMessage).steps;
        const member = view.members.find((m) => m.agentId === h.to);
        hidden.add(answer.id);
        work.push({
            key: h.taskId ?? h.key,
            agentId: h.to,
            state: member?.status === 'failed' ? 'failed' : 'done',
            task: assignmentText(h),
            steps: steps?.steps ?? [],
            stepCount: steps?.total ?? 0,
            ...(steps?.startedAt !== undefined ? { startedAt: steps.startedAt } : {}),
            ...(steps?.endedAt !== undefined ? { endedAt: steps.endedAt } : {}),
            result: textOf(answer),
            at: timeOf(view, answer) ?? AFTER_ALL,
            messageId: answer.id
        });
    });

    // Working cards: one per agent at work now, after every row; one asking you has its question instead.
    for (const w of view.live) {
        if (askers.has(w.agentId)) continue;
        const h = lastHandoff(w.agentId);
        const feed = view.feeds.find((f) => f.agentId === w.agentId);
        const rows = flight.get(w.agentId) ?? [];
        const steps = feed ? rows.flatMap((m) => stepsFromToolParts(m, feed.transcript).steps) : w.step ? [stepOfLine(w)] : [];
        work.push({
            key: feed?.taskId ?? h?.taskId ?? h?.key ?? w.agentId,
            agentId: w.agentId,
            state: 'working',
            task: assignmentText(h),
            steps,
            stepCount: steps.length,
            startedAt: w.startedAt,
            at: AFTER_ALL
        });
    }

    // Folded talk: runs of agent-to-agent messages among the rows left.
    const talk: TeamTalk[] = [];
    let run: AgentMessage[] = [];
    const close = (): void => {
        if (!run.length) return;
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const who: string[] = [];
        for (const m of run) {
            const name = view.lookup(m.actor!).name;
            if (!who.includes(name)) who.push(name);
            const to = audienceOfMessage(m, view);
            const toName = to === 'people' ? undefined : view.lookup(to).name;
            if (toName && !who.includes(toName)) who.push(toName);
        }
        const firstAt = timeOf(view, first) ?? AFTER_ALL;
        talk.push({ key: first.id, messageIds: run.map((m) => m.id), names: who, at: timeOf(view, last) ?? AFTER_ALL, openAt: firstAt - 1 });
        if (!open.has(first.id)) for (const m of run) hidden.add(m.id);
        run = [];
    };
    for (const m of all) {
        if (hidden.has(m.id) || m.parentCallId !== undefined) continue;
        if (!keep.has(m.id) && timeOf(view, m) !== undefined && audienceOfMessage(m, view) !== 'people') run.push(m);
        else close();
    }
    close();

    // The crew: one chip per member.
    const busy = view.members.filter((m) => liveBy.has(m.agentId) || askers.has(m.agentId) || m.status === 'waiting').map((m) => m.agentId);
    const crew: CrewMember[] = view.members.map((m) => {
        const who: TeamAgent = view.lookup(m.agentId);
        const base = { id: m.agentId, name: who.name, ...(who.hue ? { hue: who.hue } : {}) };
        const w = liveBy.get(m.agentId);
        const q = questions.find((x) => x.agentId === m.agentId);
        if (q || m.status === 'waiting') {
            const ask = q?.request.message?.trim();
            return { ...base, state: 'needs-you' as const, ...(w ? { startedAt: w.startedAt } : {}), ...(ask ? { ask } : {}) };
        }
        if (w) return { ...base, state: 'working' as const, startedAt: w.startedAt, ...(w.step ? { step: w.step } : {}) };
        if (m.status === 'active') return { ...base, state: 'working' as const };
        if (m.status === 'failed') return { ...base, state: 'failed' as const, step: 'failed' };
        const done = [...work].reverse().find((x) => x.agentId === m.agentId && x.state === 'done');
        if (done) return { ...base, state: 'done' as const, step: 'done', ...(done.startedAt !== undefined ? { startedAt: done.startedAt } : {}), ...(done.endedAt !== undefined ? { endedAt: done.endedAt } : {}) };
        const others = busy.filter((id) => id !== m.agentId);
        return { ...base, state: 'idle' as const, ...(others.length ? { step: `waiting on ${names(others, view)}` } : {}) };
    });

    return { messages: all.filter((m) => !hidden.has(m.id)), handoffs, work, talk, questions, crew };
}
