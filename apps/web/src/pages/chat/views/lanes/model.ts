/**
 * The Lanes view's data (#1061, CHT-09, COL-09; `docs/design/chat-modes/HANDOFF.md` → "Lanes"), read off the
 * one `ChatViewModel` every view takes. Pure:
 *
 * - **The top row** is the coordinator's latest message meant for people (`audienceOf`).
 * - **The round** starts at the latest message that hands work out (a turn with `delegate` steps): each agent
 *   it handed work to keeps its lane for the round, `Done · #22 ticked` once it stopped; with no handoff the
 *   round is the whole chat.
 * - **A lane** per member at work (working, waiting on you, a live line) or handed work this round, in member
 *   order. Idle members — nothing to do and nothing handed — get none.
 * - **A lane's body** is the agent's steps (`msg.steps`, the turn in flight's tool parts, else its live line's
 *   step) and its messages in time order; a message to another member reads `to <name>`.
 * - **Its footer** asks the agent's open question (a request its feed holds, else the chat's one open request
 *   when this is the one member waiting on you).
 */
import { audienceOf, type AgentId, type ChatEntry, type TranscriptStep } from '@agentic/core';
import type { AgentMessage, AgentPart, OpenRequest } from '@sigx/ai-agent/app';
import { questionFields, stepsFromToolParts, type CrewState, type DetailLevel, type LaneEntry, type StepsMessage, type TeamAgent } from '@agentic/ui';
import { mentionsIn } from '../../live';
import type { ChatViewModel, LiveWork } from '../types';

/** The top row: who, what, and when (the thread's own time text). */
export interface LanesTop {
    readonly agentId: string;
    readonly agent: TeamAgent;
    readonly messageId: string;
    readonly text: string;
    readonly time?: { readonly text: string; readonly dateTime?: string };
}

/** A lane's open question, and how its answers go out. */
export interface LaneAsk {
    readonly request: OpenRequest;
    readonly text: string;
    /** One button per choice; empty when the question needs typing (a free-text question, a form of several). */
    readonly choices: readonly string[];
}

export interface LaneModel {
    readonly agentId: string;
    readonly agent: TeamAgent;
    readonly state: CrewState;
    /** `#21 · Build the register in packages/ui`: what the round handed it; else what it does now. */
    readonly task: string;
    readonly entries: readonly LaneEntry[];
    readonly startedAt?: number;
    readonly endedAt?: number;
    /** `Done · #22 ticked`. */
    readonly done?: string;
    readonly ask?: LaneAsk;
}

/** The text a message says, its text parts joined. */
export function messageText(m: AgentMessage): string {
    return m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('').trim();
}

/** Who wrote each row: its `actor`, else the feed that holds it (a turn in flight). */
function authorOf(view: ChatViewModel): (m: AgentMessage) => string | undefined {
    const byFeed = new Map<string, string>();
    for (const f of view.feeds) for (const m of f.transcript.messages) byFeed.set(m.id, f.agentId);
    return (m) => (m.role === 'assistant' ? (m.actor ?? byFeed.get(m.id)) : undefined);
}

/** Who a message is for, by `audienceOf` over the members it `@`s. */
function audience(view: ChatViewModel, agentId: string, m: AgentMessage): 'people' | AgentId {
    const entry = { t: 'msg', id: m.id, author: { kind: 'agent', agentId }, parts: [], at: 0, mentions: mentionsIn(messageText(m), view.members, view.lookup) } as unknown as ChatEntry;
    return audienceOf(entry, view.members.map((x) => x.agentId as AgentId));
}

/** The coordinator's latest message meant for people; `undefined` without a coordinator or such a message. */
export function lanesTopOf(view: ChatViewModel): LanesTop | undefined {
    const coordinator = view.coordinator;
    if (!coordinator) return undefined;
    const author = authorOf(view);
    const msgs = view.thread.transcript.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (author(m) !== coordinator) continue;
        const text = messageText(m);
        if (!text || audience(view, coordinator, m) !== 'people') continue;
        const who = view.lookup(coordinator);
        const time = view.thread.describe?.(m)?.time;
        return { agentId: coordinator, agent: { name: who.name, hue: who.hue }, messageId: m.id, text, ...(time ? { time } : {}) };
    }
    return undefined;
}

/** A handoff of the round: to whom, the item and the task text. */
interface Handoff {
    readonly to: string;
    readonly item?: string;
    readonly what: string;
}

/** `Forge · Build the register` → `Build the register`: the target less the name it starts with. */
const taskText = (target: string, name: string): string => (target.startsWith(`${name} · `) ? target.slice(name.length + 3) : target);

/** The round: the index of the latest message that hands work out (0 with none), and its handoffs by agent. */
function roundOf(view: ChatViewModel): { readonly from: number; readonly handoffs: ReadonlyMap<string, Handoff> } {
    const msgs = view.thread.transcript.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const steps = (msgs[i] as StepsMessage).steps?.steps ?? [];
        const handed = steps.filter((s) => s.delegate?.to);
        if (!handed.length) continue;
        const handoffs = new Map<string, Handoff>();
        for (const s of handed) {
            const to = s.delegate!.to as string;
            handoffs.set(to, { to, ...(s.delegate!.item ? { item: s.delegate!.item } : {}), what: taskText(s.target, view.lookup(to).name) });
        }
        return { from: i + 1, handoffs };
    }
    return { from: 0, handoffs: new Map() };
}

/** `Bash · pnpm build` as a running step, for a live line with no tool part to read (the mock page). */
function liveStep(w: LiveWork): TranscriptStep | undefined {
    if (!w.step) return undefined;
    const [tool, ...rest] = w.step.split(' · ');
    return { id: `live:${w.agentId}`, turnId: `live:${w.agentId}`, agentId: w.agentId as AgentId, kind: 'other', tool: tool!, target: rest.join(' · '), state: 'running', startedAt: w.startedAt };
}

/**
 * One message's lane entries. A finished turn is its steps, then what it said (its final answer); a turn in
 * flight is its parts in order — each tool part as its step, each text as a message.
 */
function entriesOf(view: ChatViewModel, agentId: string, m: AgentMessage): LaneEntry[] {
    const to = (): { to?: string } => {
        const who = audience(view, agentId, m);
        return who === 'people' ? {} : { to: view.lookup(who).name };
    };
    const summary = (m as StepsMessage).steps;
    if (summary) {
        const text = messageText(m);
        return [...summary.steps.map((step): LaneEntry => ({ kind: 'step', step })), ...(text ? [{ kind: 'message' as const, id: m.id, text, ...to() }] : [])];
    }
    const feed = view.feeds.find((f) => f.transcript.messages.some((x) => x.id === m.id));
    const steps = new Map(stepsFromToolParts(m, feed?.transcript).steps.map((s) => [s.id, s]));
    const out: LaneEntry[] = [];
    let text = '';
    const flush = (key: number): void => {
        if (text.trim()) out.push({ kind: 'message', id: `${m.id}:${key}`, text: text.trim(), ...to() });
        text = '';
    };
    m.parts.forEach((p: AgentPart, i) => {
        if (p.type === 'text') {
            text += p.text;
            return;
        }
        if (p.type !== 'tool') return;
        flush(i);
        const step = steps.get(p.callId);
        if (step) out.push({ kind: 'step', step });
    });
    flush(m.parts.length);
    return out;
}

/** The chat's open requests, each with the agent whose feed holds it (none on the mock page). */
function openRequests(view: ChatViewModel): { readonly request: OpenRequest; readonly agentId?: string }[] {
    const seen = new Map<string, { request: OpenRequest; agentId?: string }>();
    for (const f of view.feeds) for (const r of Object.values(f.transcript.requests)) seen.set(r.requestId, { request: r, agentId: f.agentId });
    for (const r of Object.values(view.thread.transcript.requests)) if (!seen.has(r.requestId)) seen.set(r.requestId, { request: r });
    return [...seen.values()].sort((a, b) => a.request.seq - b.request.seq);
}

/** A request as a lane's question: a single question's choices as buttons; a permission as Allow once / Deny. */
export function askOf(request: OpenRequest): LaneAsk {
    if (request.kind === 'permission') {
        return { request, text: request.message?.trim() || `Allow ${request.toolName ?? 'this call'}?`, choices: [ALLOW, DENY] };
    }
    const fields = questionFields(request);
    const one = fields.length === 1 ? fields[0]! : undefined;
    const text = one?.prompt ?? request.message?.trim() ?? 'Question';
    return { request, text, choices: one && !one.multi ? one.choices.map((c) => c.label) : [] };
}

export const ALLOW = 'Allow once';
export const DENY = 'Deny';

/**
 * The lanes, in member order. `detail` Messages leaves the steps out. The coordinator gets a lane only while
 * it is at work itself — its word is the top row.
 */
export function lanesOf(view: ChatViewModel, detail: DetailLevel = view.detail): LaneModel[] {
    const author = authorOf(view);
    const round = roundOf(view);
    const msgs = view.thread.transcript.messages.slice(round.from);
    const requests = openRequests(view);
    const waiting = view.members.filter((m) => m.status === 'waiting');
    const loose = requests.filter((r) => !r.agentId);
    return view.members.flatMap((member): LaneModel[] => {
        const id = member.agentId;
        const live = view.live.find((w) => w.agentId === id);
        const own = requests.filter((r) => r.agentId === id);
        // A request no feed holds (the mock page, a chat-level request): the one member waiting on you asked it.
        const asked = own[0] ?? (waiting.length === 1 && waiting[0]!.agentId === id ? loose[0] : undefined);
        const working = live !== undefined || member.status === 'active';
        const needsYou = asked !== undefined || member.status === 'waiting';
        const handoff = round.handoffs.get(id);
        const failed = member.status === 'failed';
        if (!working && !needsYou && !failed && !handoff) return [];
        if (id === view.coordinator && !working && !needsYou) return [];

        const mine = msgs.filter((m) => author(m) === id);
        let entries = mine.flatMap((m) => entriesOf(view, id, m));
        if (live && !entries.some((e) => e.kind === 'step' && (e.step.state === 'running' || e.step.state === 'pending'))) {
            const step = liveStep(live);
            if (step) entries.push({ kind: 'step', step });
        }
        const steps = entries.flatMap((e) => (e.kind === 'step' ? [e.step] : []));
        if (detail === 'messages') entries = entries.filter((e) => e.kind === 'message');

        const state: CrewState = needsYou ? 'needs-you' : working ? 'working' : failed ? 'failed' : mine.length ? 'done' : 'idle';
        const who = view.lookup(id);
        const task = handoff ? (handoff.item ? `${handoff.item} · ${handoff.what}` : handoff.what) : (live?.step ?? '');
        const first = steps[0]?.startedAt;
        const last = steps.reduce<number | undefined>((at, s) => (s.endedAt !== undefined && (at === undefined || s.endedAt > at) ? s.endedAt : at), undefined);
        const times = state === 'working'
            ? { startedAt: live?.startedAt ?? first }
            : state === 'needs-you'
                // Since its turn started, when a feed says so; a finished step's end is not when it began to wait.
                ? { startedAt: live?.startedAt }
                : { startedAt: first, endedAt: last };
        return [{
            agentId: id,
            agent: { name: who.name, hue: who.hue },
            state,
            task,
            entries,
            ...(times.startedAt !== undefined ? { startedAt: times.startedAt } : {}),
            ...('endedAt' in times && times.endedAt !== undefined ? { endedAt: times.endedAt } : {}),
            ...(state === 'done' ? { done: handoff?.item ? `Done · ${handoff.item} ticked` : 'Done' } : {}),
            ...(asked ? { ask: askOf(asked.request) } : {})
        }];
    });
}
