/**
 * `Thread` — the transcript (`ai-thread`): a `role="log"` container that
 * WINDOWS its rows, opens at the bottom, sticks to it while the reader is
 * there, and pauses when they scroll up.
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
 * - clientHeight <= threshold`), and only a scroll UP past the threshold
 * flips it off — a pin, or content growing under the viewport, never moves
 * the offset up, so it cannot pause the thread (#495). The window's `end`
 * freezes at that moment so rows do not shift under the reader while the
 * agent goes on streaming. While following, the bottom is pinned on mount,
 * after every render, and on every resize of the list — a streaming part
 * re-renders only itself, so the thread's own render does not see it grow.
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
 *
 * `inserts` are the host's own rows placed by time (#870) — each before the
 * first message later than it (`./interleave`, reading the message times
 * `describe` gives). One shows while the row it precedes is in the window;
 * the ones after every message show while the window reaches the tail.
 */
import { component, onMounted, onUnmounted, type Define, type JSXElement } from '@sigx/runtime-core';
import { spawnedAgent } from '@sigx/ai-agent';
import type { AgentMessage, AgentTranscript, OpenRequest } from '@sigx/ai-agent/app';
import { aiThreadAnatomy } from './anatomy.js';
import { ApprovalPrompt, type RespondFn } from './ApprovalPrompt.js';
import { QuestionPrompt } from './QuestionPrompt.js';
import { Message, type MessageAuthor } from './Message.js';
import { approvalContext, type DescribeRequestFn, type PullLinksFn, type ToolLinksFn, type ToolMetaFn } from './ToolCall.js';
import { isoTime, placeInserts } from './interleave.js';
import { DEFAULT_WINDOW, followRange, frozenRange, unitCount, windowRows } from './window.js';

const SCOPE = aiThreadAnatomy.scope;

export type DescribeFn = (message: AgentMessage) => MessageAuthor | undefined;

/** A host row placed in the thread by time (#870): a request card, a divider, a result card. */
export interface ThreadInsert {
    /** Stable across renders and unique in the thread. */
    readonly key: string;
    /** When it happened (epoch ms): it sits before the first message later than this. */
    readonly at: number;
    readonly render: () => JSXElement;
}

export type ThreadProps =
    & Define.Prop<'transcript', AgentTranscript, true>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>
    /** Who a row's author is — hue, environment, time — resolved by the page. */
    & Define.Prop<'describe', DescribeFn, false>
    /** Header meta per tool call (duration, diff stat, task id). */
    & Define.Prop<'toolMeta', ToolMetaFn, false>
    /** Links a page puts on a call's card ("View diff"). */
    & Define.Prop<'toolLinks', ToolLinksFn, false>
    /** Where a pull request a call returned leads (its `PullCard`): the PR page and its diff; the provider's page by default. */
    & Define.Prop<'pullLinks', PullLinksFn, false>
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
    /** Host rows placed among the messages by time — see `ThreadInsert`. */
    & Define.Prop<'inserts', readonly ThreadInsert[], false>
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
    let list: HTMLElement | null = null;
    /** The offset the last scroll (or pin) left: a scroll below it moved up. */
    let lastTop = 0;
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
        if (!root) return;
        root.scrollTop = root.scrollHeight;
        lastTop = root.scrollTop;
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
        const up = el.scrollTop < lastTop;
        lastTop = el.scrollTop;
        // At the bottom follows; away from it pauses only when the reader moved up.
        const following = gap <= threshold() || (st.following && !up);
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

    // Open at the tail, and hold it while the list grows between renders
    // (streaming deltas, markdown, images, a card expanding).
    let observer: ResizeObserver | undefined;
    onMounted(() => {
        scrollToBottom();
        if (typeof ResizeObserver === 'undefined' || !list) return;
        observer = new ResizeObserver(() => {
            if (st.following) scrollToBottom();
        });
        observer.observe(list);
    });
    onUnmounted(() => observer?.disconnect());

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
        if (before !== undefined) root.scrollTop += root.scrollHeight - before;
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
        const placed = placeInserts(messages, props.inserts ?? [], (m) => isoTime(props.describe?.(m)?.time?.dateTime));
        const insertRow = (insert: ThreadInsert) => (
            <li key={`insert:${insert.key}`} data-scope={SCOPE} data-part="row" data-insert="">
                {insert.render()}
            </li>
        );
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
                <ol
                    data-scope={SCOPE}
                    data-part="list"
                    ref={(el: HTMLElement | null) => {
                        list = el;
                    }}
                >
                    {rows.flatMap((row) => [
                        ...(placed.before.get(row.key) ?? []).map(insertRow),
                        <li key={row.key} data-scope={SCOPE} data-part="row">
                            <Message
                                message={row.message}
                                from={row.from}
                                to={row.to}
                                transcript={props.transcript}
                                author={props.describe?.(row.message)}
                                streaming={streaming && row.message === lastAssistant}
                                toolMeta={props.toolMeta}
                                toolLinks={props.toolLinks}
                                pullLinks={props.pullLinks}
                                logHref={props.logHref}
                                onRespond={props.onRespond}
                                describeRequest={props.describeRequest}
                                onCancelAgent={props.onCancelAgent}
                            />
                        </li>
                    ])}
                    {range.end === total && placed.after.map(insertRow)}
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
