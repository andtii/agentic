/**
 * A step's full output on the Session page (#1056, AGT-09, CHT-09): the chat's
 * steps box links `Full output` to `/sessions/:id?call=<callId>`; the page
 * scrolls to that tool call, highlights its row in the event log, and shows
 * the call's input and whole output — never the thread's clipped well. A call
 * the session no longer holds (a daemon session keeps its newest pages only,
 * #397) says so.
 */
import { component, onMounted, type Define, type JSXElement } from 'sigx';
import { createTranscript, reduceAgentEvent, type AgentEvent } from '@sigx/ai-agent';
import type { AgentTranscript, ToolPartState } from '@sigx/ai-agent/app';
import { ToolCall } from '@agentic/ui';
import { Panel } from '../../components/Panel';
import { transcriptHref } from './files';

/** `/sessions/:id?call=<callId>` — the Session page at one tool call. */
export const callHref = (sessionId: string, callId: string): string => `${transcriptHref(sessionId)}?call=${encodeURIComponent(callId)}`;

/**
 * A step's `output.ref` (`<sessionId>#<callId>`, `TranscriptStep.output`) as the Session page's href;
 * `undefined` for a ref that names no session or no call.
 */
export function refHref(ref: string): string | undefined {
    const at = ref.indexOf('#');
    if (at <= 0 || at === ref.length - 1) return undefined;
    return callHref(ref.slice(0, at), ref.slice(at + 1));
}

/** The DOM id of a tool call's row in the event log. */
export const callRowId = (callId: string): string => `call-${callId}`;

/** What the page knows about the requested call: still reading, found (the call folded), or not held any more. */
export type CallFocus =
    | { readonly callId: string; readonly status: 'loading' }
    | { readonly callId: string; readonly status: 'found'; readonly part: ToolPartState; readonly transcript?: AgentTranscript }
    | { readonly callId: string; readonly status: 'missing' };

/** The call `callId` folded out of `events` (its `tool-call` and every update); `null` when the events hold no such call. */
export function callIn(sessionId: string, events: readonly AgentEvent[], callId: string): { part: ToolPartState; transcript: AgentTranscript } | null {
    if (!events.some((e) => e.type === 'tool-call' && e.callId === callId)) return null;
    const transcript = createTranscript(sessionId);
    for (const ev of events) reduceAgentEvent(transcript, ev);
    for (const m of transcript.messages) {
        for (const p of m.parts) if (p.type === 'tool' && p.callId === callId) return { part: p, transcript };
    }
    return null;
}

/** A value as the raw block prints it: a string as is, anything else pretty JSON. */
export function rawText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/** The call's whole output: its `output`, else the text of its content blocks. */
function fullOutput(p: ToolPartState): string {
    if (p.output !== undefined) return rawText(p.output);
    return (p.content ?? []).map((b) => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : rawText(b))).join('\n');
}

/** Scroll `el` into view where the platform can (jsdom has no layout, and no `scrollIntoView`). */
const reveal = (el: Element | null): void => {
    const scroll = (el as { scrollIntoView?: (o?: ScrollIntoViewOptions) => void } | null)?.scrollIntoView;
    if (scroll) scroll.call(el, { block: 'start' });
};

export type FocusedCallProps = Define.Prop<'focus', CallFocus, true>;

/** The requested call, raw: the tool card, then its input and its whole output, unclipped. */
export const FocusedCall = component<FocusedCallProps>(({ props }) => {
    let root: HTMLElement | null = null;
    onMounted(() => reveal(root));
    return (): JSXElement => {
        const f = props.focus;
        return (
            <div data-call-focus data-status={f.status} data-call-id={f.callId} ref={(el: HTMLElement | null) => { root = el; }}>
                <Panel label={`Step · ${f.callId}`}>
                    {f.status === 'loading' ? <p data-panel-note aria-busy="true">Reading the session log…</p> : null}
                    {f.status === 'missing'
                        ? <p data-call-missing role="note">This session no longer holds call {f.callId}: its log keeps only the newest events, and this step is older than that — or the call never ran here.</p>
                        : null}
                    {f.status === 'found' ? <FoundCall part={f.part} {...(f.transcript ? { transcript: f.transcript } : {})} /> : null}
                </Panel>
            </div>
        );
    };
}, { name: 'FocusedCall' });

const FoundCall = component<Define.Prop<'part', ToolPartState, true> & Define.Prop<'transcript', AgentTranscript>>(({ props }) => () => {
    const p = props.part;
    const output = fullOutput(p);
    return (
        <div data-call-raw>
            <ToolCall part={p} {...(props.transcript ? { transcript: props.transcript } : {})} />
            <section data-call-input aria-label="Input">
                <h3 data-call-label>Input</h3>
                <pre>{rawText(p.input) || p.inputText || ''}</pre>
            </section>
            <section data-call-output aria-label="Full output">
                <h3 data-call-label>Full output</h3>
                {output ? <pre>{output}</pre> : <p data-panel-note>{p.status === 'completed' || p.status === 'failed' ? 'The call returned no output.' : 'No output yet.'}</p>}
                {p.error ? <pre data-call-error>{p.error}</pre> : null}
            </section>
        </div>
    );
}, { name: 'FocusedCall.Found' });
