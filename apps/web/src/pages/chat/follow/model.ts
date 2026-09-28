/**
 * What the Follow panel shows (#1060, CHT-09, AGT-09), read off the chat's view model and the followed
 * agent's session feed — nothing here writes anywhere:
 * - the state: waiting on you while its session awaits an answer, working while it has a live line, failed
 *   or done once its turn ended, else the member's own status (the mock page has no feeds);
 * - the task: the handoff that gave it the work (`delegate` step to it), else the prompt of its turn;
 * - the last steps: its turn in the feed, else its newest message in the thread;
 * - the live output: the tail of its `coding.terminal` output when the feed folds coding events, else the
 *   newest output of its turn's tool calls (the running one's partial output first);
 * - the result: the turn's last words once it is over.
 */
import type { TranscriptStep } from '@agentic/core';
import type { AgentMessage, AgentTranscript, ToolPartState } from '@sigx/ai-agent/app';
import { codingState } from '@sigx/ai-agent/coding';
import { stepsFromToolParts, type AgentHue, type CrewState, type StepsMessage } from '@agentic/ui';
import { sessionMidTurn } from '../live';
import type { FollowModel } from './index';

export interface FollowView {
    readonly name: string;
    readonly hue?: AgentHue;
    readonly state: CrewState;
    readonly task: string;
    /** `machine / runtime`. */
    readonly env?: string;
    readonly steps: readonly TranscriptStep[];
    readonly output: readonly string[];
    readonly result?: string;
    /** Stop the turn (the live line's Stop: `Session.cancel` through the feed); absent when nothing runs. */
    readonly onStop?: () => void;
}

/** The lines kept of any output: the panel shows the last few. */
const KEEP_LINES = 40;

const tail = (text: string): string[] => {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    return lines.slice(-KEEP_LINES);
};

const textOf = (m: AgentMessage): string => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();

/** A tool call's output as text: a string as is, text blocks joined, anything else as JSON. */
export function toolOutputText(part: ToolPartState): string | undefined {
    if (typeof part.output === 'string') return part.output || undefined;
    const blocks = (part.content ?? []).flatMap((b) => (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : []));
    if (blocks.length) return blocks.join('\n');
    if (part.output === undefined || part.output === null) return undefined;
    try {
        return JSON.stringify(part.output, null, 2);
    } catch {
        return String(part.output);
    }
}

/** The messages of the feed's current (or last) turn, top level only. */
export function turnMessages(t: AgentTranscript): AgentMessage[] {
    const turnId = t.turn?.turnId;
    if (!turnId) return [];
    return t.messages.filter((m) => m.turnId === turnId && m.parentCallId === undefined);
}

/** The live output of a session: its newest terminal's tail, else its turn's newest tool output (a running call first). */
export function liveOutput(t: AgentTranscript): string[] {
    const coding = codingState(t);
    const terminals = coding ? Object.values(coding.terminals).filter((x) => x.output.length > 0) : [];
    if (terminals.length) return tail(terminals[terminals.length - 1]!.output);
    const tools = turnMessages(t).filter((m) => m.role === 'assistant').flatMap((m) => m.parts.filter((p): p is ToolPartState => p.type === 'tool'));
    const running = [...tools].reverse().find((p) => p.status === 'in_progress' && toolOutputText(p) !== undefined);
    const newest = running ?? [...tools].reverse().find((p) => toolOutputText(p) !== undefined);
    const text = newest ? toolOutputText(newest) : undefined;
    return text ? tail(text) : [];
}

const stepsOfMessage = (m: AgentMessage, t?: AgentTranscript): readonly TranscriptStep[] => (m as StepsMessage).steps?.steps ?? stepsFromToolParts(m, t).steps;

/** `Build the register in packages/ui · #21`: the handoff to the agent, its `Name · ` prefix dropped. */
function handoffTo(agentId: string, name: string, messages: readonly AgentMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const steps = (messages[i] as StepsMessage).steps?.steps ?? [];
        const step = [...steps].reverse().find((s) => s.delegate?.to === agentId);
        if (!step) continue;
        const prefix = `${name} · `;
        const what = step.target.startsWith(prefix) ? step.target.slice(prefix.length) : step.target;
        return step.delegate?.item ? `${what} · ${step.delegate.item}` : what;
    }
    return undefined;
}

/** The first line of the turn's prompt, when the feed carries it. */
function promptOf(t: AgentTranscript): string | undefined {
    const prompt = turnMessages(t).find((m) => m.role === 'user');
    const line = prompt ? textOf(prompt).split('\n')[0]?.trim() : undefined;
    return line || undefined;
}

export function followView(model: FollowModel): FollowView {
    const { agentId, feed, view } = model;
    const who = view.lookup(agentId);
    const live = view.live.find((w) => w.agentId === agentId);
    const member = view.members.find((m) => m.agentId === agentId);
    const t = feed?.transcript;
    const ownMessages = view.thread.transcript.messages.filter((m) => m.role === 'assistant' && (m.actor ?? m.author) === agentId);
    const turn = t ? turnMessages(t).filter((m) => m.role === 'assistant') : [];

    let state: CrewState;
    if (t?.state === 'awaiting' || (!t && member?.status === 'waiting')) state = 'needs-you';
    else if (live || (t && sessionMidTurn(t))) state = 'working';
    else if (t?.turn?.stopReason === 'error' || (!t && member?.status === 'failed')) state = 'failed';
    // A turn you stopped is not a result: the member is idle again.
    else if (t?.turn?.stopReason === 'cancelled') state = 'idle';
    else if (t?.turn?.stopReason || member?.status === 'completed' || (!t && ownMessages.length > 0)) state = 'done';
    else state = 'idle';

    // The steps: the turn in the feed while it has any, else the agent's newest message in the thread.
    const feedSteps = turn.flatMap((m) => stepsOfMessage(m, t));
    const last = ownMessages[ownMessages.length - 1];
    const steps = feedSteps.length ? feedSteps : last ? stepsOfMessage(last, view.thread.transcript) : [];

    const lastTurnWords = [...turn].reverse().map(textOf).find((x) => x.length > 0);
    const result = state === 'done' || state === 'failed' ? (lastTurnWords ?? (last ? textOf(last) || undefined : undefined)) : undefined;

    const env = who.environment.machine && who.environment.machine !== '—' ? `${who.environment.machine} / ${who.environment.runtime}` : undefined;
    const task = handoffTo(agentId, who.name, view.thread.transcript.messages) ?? (t ? promptOf(t) : undefined) ?? live?.step ?? 'No task yet';
    return {
        name: who.name,
        hue: who.hue,
        state,
        task,
        ...(env ? { env } : {}),
        steps,
        output: t ? liveOutput(t) : [],
        ...(result ? { result } : {}),
        ...(live?.onStop ? { onStop: live.onStop } : {})
    };
}
