/**
 * `Thread` — the transcript (`ai-thread`): a `role="log"` container that
 * WINDOWS its rows, sticks to the bottom while the reader is there, and
 * pauses when they scroll up.
 *
 * Driven by a reactive `AgentTranscript` — `useAgentSession(...).transcript`,
 * or any transcript the reducer folds in place. This component reads the
 * message list and each message's part COUNT, so a new part re-runs the
 * window; a `part-delta` touches one part's text and re-runs that part
 * alone (`Message` / `StreamingMarkdown`). Zero has no virtualised list, so
 * the window is our own: at most `window` parts are in the DOM at once
 * (`./window`), the "Showing the last N entries · Load earlier" chip widens
 * it backwards, and the "Jump to latest" anchor — hidden while following —
 * resumes the tail.
 *
 * Following is decided from real scroll geometry (`scrollHeight - scrollTop
 * - clientHeight <= threshold`), which is what a scroll-up flips off; the
 * window's `end` freezes at that moment so rows do not shift under the
 * reader while the agent goes on streaming.
 *
 * Who an author is (hue, environment, time) comes from the page through
 * `describe`; the STREAMING pill sits on the last assistant row while the
 * session is mid-turn.
 */
import { component, type Define } from '@sigx/runtime-core';
import { spawnedAgent } from '@sigx/ai-agent';
import type { AgentMessage, AgentTranscript, OpenRequest } from '@sigx/ai-agent/app';
import { aiThreadAnatomy } from './anatomy.js';
import { ApprovalPrompt, type RespondFn } from './ApprovalPrompt.js';
import { Message, type MessageAuthor } from './Message.js';
import type { DescribeRequestFn, ToolMetaFn } from './ToolCall.js';
import { DEFAULT_WINDOW, followRange, frozenRange, unitCount, windowRows } from './window.js';

const SCOPE = aiThreadAnatomy.scope;

export type DescribeFn = (message: AgentMessage) => MessageAuthor | undefined;

export type ThreadProps =
    & Define.Prop<'transcript', AgentTranscript, true>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>
    /** Who a row's author is — hue, environment, time — resolved by the page. */
    & Define.Prop<'describe', DescribeFn, false>
    /** Header meta per tool call (duration, diff stat, task id). */
    & Define.Prop<'toolMeta', ToolMetaFn, false>
    /** The approval card's context rows per request — rule, requester, environment, delegation path — resolved by the page. */
    & Define.Prop<'describeRequest', DescribeRequestFn, false>
    /** The session log long outputs link to. */
    & Define.Prop<'logHref', string, false>
    /** Most parts in the DOM at once. Default 150. */
    & Define.Prop<'window', number, false>
    /** Pixels from the bottom within which the thread still counts as following. Default 24. */
    & Define.Prop<'threshold', number, false>
    /** Accessible name of the log. Default "Transcript". */
    & Define.Prop<'label', string, false>;

/**
 * The thread's own messages: one produced inside a sub-agent renders on that
 * agent's card instead — but only when an agent claims its call, so a
 * harness that nests work without announcing an agent still shows it here.
 */
export function threadMessages(transcript: AgentTranscript): AgentMessage[] {
    return transcript.messages.filter((m) => m.parentCallId === undefined || !spawnedAgent(transcript, m.parentCallId));
}

/** Open permission requests with no tool call of their own — the rest render on their card. */
export function looseRequests(transcript: AgentTranscript): OpenRequest[] {
    return Object.values(transcript.requests)
        .filter((r) => r.kind === 'permission' && r.callId === undefined)
        .sort((a, b) => a.seq - b.seq);
}

/** The session is mid-turn: running, or waiting on an answer. */
export function midTurn(transcript: AgentTranscript): boolean {
    return transcript.state === 'running' || transcript.state === 'awaiting';
}

export const Thread = component<ThreadProps>(({ props, signal, onUpdated }) => {
    const st = signal({
        /** Stuck to the bottom. */
        following: true,
        /** The window's end while paused (units). */
        end: 0,
        /** How many extra units "Load earlier" opened. */
        extra: 0
    });
    let root: HTMLElement | null = null;

    const size = (): number => Math.max(1, props.window ?? DEFAULT_WINDOW);
    const threshold = (): number => props.threshold ?? 24;

    const scrollToBottom = (): void => {
        if (root) root.scrollTop = root.scrollHeight;
    };

    const onScroll = (e: Event): void => {
        const el = e.currentTarget as HTMLElement;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        const following = gap <= threshold();
        if (following === st.following) return;
        if (!following) st.end = unitCount(threadMessages(props.transcript));
        else st.extra = 0;
        st.following = following;
    };

    const jump = (): void => {
        st.following = true;
        st.extra = 0;
        scrollToBottom();
    };

    // After every render: keep the tail in view while following. The DOM
    // has been patched by now, which is what makes scrollHeight current.
    onUpdated(() => {
        if (st.following) scrollToBottom();
    });

    return () => {
        const messages = threadMessages(props.transcript);
        const total = unitCount(messages);
        const range = st.following ? followRange(total, size(), st.extra) : frozenRange(total, st.end, size(), st.extra);
        const rows = windowRows(messages, range);
        const loose = looseRequests(props.transcript);
        const streaming = midTurn(props.transcript);
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
        const shown = range.end - range.start;
        return (
            <div
                data-scope={SCOPE}
                data-part="root"
                data-state={st.following ? 'on' : 'off'}
                role="log"
                aria-live="polite"
                aria-label={props.label ?? 'Transcript'}
                ref={(el: HTMLElement | null) => {
                    root = el;
                }}
                onScroll={onScroll}
            >
                {range.start > 0 && (
                    <button
                        type="button"
                        data-scope={SCOPE}
                        data-part="earlier"
                        onClick={() => {
                            st.extra += size();
                        }}
                    >
                        <span>{`Showing the last ${shown} entries`}</span>
                        <span aria-hidden="true">·</span>
                        <u>Load earlier</u>
                    </button>
                )}
                <ol data-scope={SCOPE} data-part="list">
                    {rows.map((row) => (
                        <li key={row.key} data-scope={SCOPE} data-part="row">
                            <Message
                                message={row.message}
                                from={row.from}
                                to={row.to}
                                transcript={props.transcript}
                                author={props.describe?.(row.message)}
                                streaming={streaming && row.message === lastAssistant}
                                toolMeta={props.toolMeta}
                                logHref={props.logHref}
                                onRespond={props.onRespond}
                                describeRequest={props.describeRequest}
                                onCancelAgent={props.onCancelAgent}
                            />
                        </li>
                    ))}
                    {props.onRespond &&
                        loose.map((r) => (
                            <li key={`request:${r.requestId}`} data-scope={SCOPE} data-part="row">
                                <ApprovalPrompt request={r} onRespond={props.onRespond!} {...props.describeRequest?.(r)} />
                            </li>
                        ))}
                </ol>
                <button type="button" data-scope={SCOPE} data-part="anchor" data-state={st.following ? 'on' : 'off'} hidden={st.following} onClick={jump}>
                    Jump to latest
                </button>
            </div>
        );
    };
}, { name: 'Thread' });
