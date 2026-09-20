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
 * The host may hold more than the transcript (a chat whose older entries are
 * paged from a store): with `hasEarlier` the chip stays once the window is
 * fully open and reaching the top — the chip, or a scroll to within
 * `threshold` of it — calls `onEarlier`; rows the host then prepends keep
 * the frozen rows where they were (the window's end moves with them and the
 * scroll offset absorbs the new height), so paging never jumps the reader.
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
import { QuestionPrompt } from './QuestionPrompt.js';
import { Message, type MessageAuthor } from './Message.js';
import { approvalContext, type DescribeRequestFn, type ToolMetaFn } from './ToolCall.js';
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
    /** The host holds rows before the transcript's first (#398): the "Load earlier" chip stays once the window is fully open, and reaching the top asks for them. */
    & Define.Prop<'hasEarlier', boolean, false>
    /** Asked for the rows before the transcript's first — by the chip, or by a scroll to within `threshold` of the top — while `hasEarlier`; the host prepends them. */
    & Define.Prop<'onEarlier', () => void, false>
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

/** Open requests with no tool call of their own — the rest render on their card. */
export function looseRequests(transcript: AgentTranscript): OpenRequest[] {
    return Object.values(transcript.requests)
        .filter((r) => r.callId === undefined)
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
    /** The first message when the window froze: rows prepended before it move the frozen `end` by their units. */
    let frozenFirst: string | undefined;
    /** The last render's first unit; its first row against the first row the DOM last settled on, and the scroll height before the change — the prepend correction reads them. */
    let lastStart = 0;
    let firstKey: string | undefined;
    let settledFirstKey: string | undefined;
    let heightBefore: number | undefined;
    /** The top was reached and `onEarlier` asked; re-armed by a scroll away or by rows arriving. */
    let askedTop = false;

    const size = (): number => Math.max(1, props.window ?? DEFAULT_WINDOW);
    const threshold = (): number => props.threshold ?? 24;

    const scrollToBottom = (): void => {
        if (root) root.scrollTop = root.scrollHeight;
    };

    /** The units now before the message that was first when the window froze — what the host prepended since. */
    const prepended = (messages: readonly AgentMessage[]): number => {
        if (frozenFirst === undefined) return 0;
        const at = messages.findIndex((m) => m.id === frozenFirst);
        return at > 0 ? unitCount(messages.slice(0, at)) : 0;
    };

    /** More before the first row shown: widen the window while rows are windowed away, else ask the host. */
    const earlier = (): void => {
        if (lastStart > 0) st.extra += size();
        else if (props.hasEarlier) props.onEarlier?.();
    };

    const onScroll = (e: Event): void => {
        const el = e.currentTarget as HTMLElement;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        const following = gap <= threshold();
        if (following !== st.following) {
            if (!following) {
                const messages = threadMessages(props.transcript);
                st.end = unitCount(messages);
                frozenFirst = messages[0]?.id;
            } else {
                st.extra = 0;
                frozenFirst = undefined;
            }
            st.following = following;
        }
        // The top: asked once per approach, so a fetch in flight is not asked for again on every scroll tick. The
        // flag is set before the ask, whose re-render may settle synchronously and re-arm it for the new rows.
        const atTop = el.scrollTop <= threshold();
        const ask = atTop && !askedTop;
        askedTop = atTop;
        if (ask) earlier();
    };

    const jump = (): void => {
        st.following = true;
        st.extra = 0;
        frozenFirst = undefined;
        scrollToBottom();
    };

    // After every render: keep the tail in view while following; frozen, keep
    // the reader's rows where they were when rows were prepended (the first
    // row changed) by moving the offset by the height that arrived above. The
    // DOM has been patched by now, which is what makes scrollHeight current.
    onUpdated(() => {
        const arrived = !st.following && firstKey !== settledFirstKey;
        settledFirstKey = firstKey;
        const before = heightBefore;
        heightBefore = undefined;
        if (!root) return;
        if (st.following) {
            scrollToBottom();
            return;
        }
        if (!arrived) return;
        if (before) root.scrollTop += root.scrollHeight - before;
        askedTop = false;
    });

    return () => {
        const messages = threadMessages(props.transcript);
        const total = unitCount(messages);
        const range = st.following ? followRange(total, size(), st.extra) : frozenRange(total, st.end + prepended(messages), size(), st.extra);
        const rows = windowRows(messages, range);
        const loose = looseRequests(props.transcript);
        const streaming = midTurn(props.transcript);
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
        const shown = range.end - range.start;
        const more = range.start > 0 || props.hasEarlier === true;
        lastStart = range.start;
        firstKey = rows[0]?.key;
        // Before the DOM is patched: the height `onUpdated` compares against (a layout read, so only while frozen and only once per change).
        if (!st.following && root && heightBefore === undefined) heightBefore = root.scrollHeight;
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
                {more && (
                    <button
                        type="button"
                        data-scope={SCOPE}
                        data-part="earlier"
                        onClick={earlier}
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
                                {r.kind === 'input'
                                    ? <QuestionPrompt request={r} onRespond={props.onRespond!} requestedBy={props.describeRequest?.(r)?.requestedBy} stale={props.describeRequest?.(r)?.stale} />
                                    : <ApprovalPrompt request={r} onRespond={props.onRespond!} {...approvalContext(props.describeRequest?.(r))} />}
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
