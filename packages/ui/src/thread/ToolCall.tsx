/**
 * `ToolCall` — one tool part as the handoff's card (`ai-tool-call`,
 * `docs/design/HANDOFF.md` → "Tool call `data-state`"): the header carries
 * an icon in the state colour, the tool name, the signature truncated, an
 * optional meta (duration, diff stat, task id) and the status pill; the
 * input folds in a `<details>`, the output is a well that folds past six
 * lines behind "Show N more lines" and links to the session log past two
 * hundred; an error line; the approval card in place while the call waits
 * on the operator; the sub-agent card when the call spawned one.
 *
 * `data-state` is the governed lifecycle (`./tool-state`): `loading` while
 * pending — arguments still streaming, or awaiting approval — `active` while
 * running, `complete`, `error`, and `closed` for a denied call. The pill
 * says the phase in the handoff's words (PENDING, RUNNING, DONE, ERROR,
 * DENIED); a refined phase (`awaiting approval`, `cancelled`, `no output`)
 * is the meta text when the caller gave none.
 */
import { component, type Define } from '@sigx/runtime-core';
import { agentMessages } from '@sigx/ai-agent';
import type { AgentState, AgentTranscript, OpenRequest, ToolPartState } from '@sigx/ai-agent/app';
import { Button } from '../kit/Button.js';
import { Icon, type IconName } from '../kit/icons.js';
import { StatusPill } from '../kit/StatusPill.js';
import { aiToolCallAnatomy } from './anatomy.js';
import { ApprovalPrompt, type ApprovalPromptProps, type RespondFn } from './ApprovalPrompt.js';
import { Message } from './Message.js';
import { agentState, toolCallState, type ToolCallPhase } from './tool-state.js';
import { inputText, nonBlank, oneLine, outputText, reportedOutput, signature } from './text.js';

const SCOPE = aiToolCallAnatomy.scope;

/** Lines the output well shows before "Show N more lines". */
export const OUTPUT_FOLD = 6;
/** Lines past which the well hands over to the session log. */
export const OUTPUT_LOG = 200;

/** What the page knows about a call that the part does not — `3.4s`, `+18 −6`, `t_8f2c`. */
export type ToolMetaFn = (part: ToolPartState) => string | undefined;

/** What the page knows about a request that the transcript does not: the rule it matched, who asked, where it runs, the delegation path, a settled decision. */
export type ApprovalContext = Pick<ApprovalPromptProps, 'toolName' | 'input' | 'rule' | 'requestedBy' | 'environment' | 'via' | 'decision' | 'compact'>;
/** Resolves the approval card's context rows for a request (`docs/design/HANDOFF.md` → `ai-approval`); absent = the bare card. */
export type DescribeRequestFn = (request: OpenRequest) => ApprovalContext | undefined;

/** What every card in a thread shares: the transcript (for sub-agents), the way to answer a request, the way to stop an agent. */
export interface ThreadContextProps {
    readonly transcript?: AgentTranscript;
    readonly onRespond?: RespondFn;
    readonly describeRequest?: DescribeRequestFn;
    /** Offered only when the agent controls its sub-agents (`capabilities.subagents === 'control'`). */
    readonly onCancelAgent?: (agentId: string) => void;
}

export type ToolCallProps =
    & Define.Prop<'part', ToolPartState, true>
    & Define.Prop<'transcript', AgentTranscript, false>
    /** Duration, diff stat, task id — the header's meta text. */
    & Define.Prop<'meta', string, false>
    /** The session log an output past 200 lines links to. */
    & Define.Prop<'logHref', string, false>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'describeRequest', DescribeRequestFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>;

/** The 15 px header icon: what a machine did, by tool name. */
export function toolIcon(name: string): IconName {
    const n = name.toLowerCase();
    if (/(bash|shell|exec|command|run|terminal)/.test(n)) return 'terminal';
    if (/(read|edit|write|file|glob|grep|search)/.test(n)) return 'file';
    if (/(delegate|agent|task|spawn)/.test(n)) return 'delegate';
    if (/(fetch|http|url|web|link)/.test(n)) return 'link';
    return 'terminal';
}

/** The pill status per phase — the handoff's five words. */
const PILL: Record<ToolCallPhase, string> = { pending: 'pending', running: 'running', done: 'done', error: 'error', denied: 'denied' };

/** The input block on a native `<details>`; the reader's toggle wins over the default. */
const InputBlock = component<Define.Prop<'text', string, true>>(({ props, signal }) => {
    const st = signal({ open: undefined as boolean | undefined });
    return () => {
        const open = st.open ?? false;
        return (
            <details
                data-scope={SCOPE}
                data-part="input"
                data-state={open ? 'open' : 'closed'}
                open={open}
                onToggle={(e: Event) => {
                    st.open = (e.currentTarget as HTMLDetailsElement).open;
                }}
            >
                <summary>input</summary>
                <pre>{props.text}</pre>
            </details>
        );
    };
}, { name: 'ToolCall.Input' });

/**
 * The output well: open by default, the first six lines, then "Show N more
 * lines"; past two hundred lines the rest lives in the session log.
 */
const OutputBlock = component<Define.Prop<'text', string, true> & Define.Prop<'logHref', string, false>>(({ props, signal }) => {
    const st = signal({ open: undefined as boolean | undefined, expanded: false });
    return () => {
        const open = st.open ?? true;
        const lines = props.text.split('\n');
        const total = lines.length;
        const capped = Math.min(total, OUTPUT_LOG);
        const shown = st.expanded ? lines.slice(0, capped) : lines.slice(0, Math.min(OUTPUT_FOLD, capped));
        const folded = capped - shown.length;
        const beyond = total - capped;
        return (
            <details
                data-scope={SCOPE}
                data-part="output"
                data-state={open ? 'open' : 'closed'}
                open={open}
                onToggle={(e: Event) => {
                    st.open = (e.currentTarget as HTMLDetailsElement).open;
                }}
            >
                <summary>output</summary>
                <pre>{shown.join('\n')}</pre>
                {folded > 0 && (
                    <button
                        type="button"
                        data-scope={SCOPE}
                        data-part="more"
                        onClick={() => {
                            st.expanded = true;
                        }}
                    >
                        {`Show ${folded} more line${folded === 1 ? '' : 's'}`}
                    </button>
                )}
                {st.expanded && beyond > 0 && props.logHref && (
                    <a data-scope={SCOPE} data-part="log" href={props.logHref}>
                        {`${beyond} more line${beyond === 1 ? '' : 's'} in the session log`}
                    </a>
                )}
            </details>
        );
    };
}, { name: 'ToolCall.Output' });

/**
 * The sub-agent a call spawned: who it is, its status, a Cancel while it
 * runs (from the capability, never from who the agent is), and — folded away
 * once it is done — its own messages through the same `Message`. That is the
 * recursion: a sub-agent's own spawning call carries its own card.
 */
const AgentCard = component<Define.Prop<'agent', AgentState, true> & ThreadContextProps>(({ props }) => {
    return () => {
        const { agent, transcript } = props;
        const running = agent.status === 'running' || agent.status === 'paused';
        const summary = nonBlank(agent.summary === undefined ? undefined : oneLine(agent.summary));
        const error = nonBlank(agent.error?.message);
        const messages = transcript ? agentMessages(transcript, agent.agentId) : [];
        const cancel = props.onCancelAgent;
        return (
            <div data-scope={SCOPE} data-part="agent" data-state={agentState(agent.status)}>
                <p>
                    <strong>{agent.title ?? agent.kind ?? 'sub-agent'}</strong> <span>{agent.status}</span>
                    {cancel && running && (
                        <Button intent="default" onClick={() => cancel(agent.agentId)}>
                            Cancel
                        </Button>
                    )}
                </p>
                {summary && <p>{summary}</p>}
                {error && <p data-scope={SCOPE} data-part="error">{error}</p>}
                {messages.length > 0 && (
                    <details open={running}>
                        <summary>{running ? 'Working…' : `Its work (${messages.length} message${messages.length === 1 ? '' : 's'})`}</summary>
                        {messages.map((m) => (
                            <Message key={m.id} message={m} transcript={transcript} onRespond={props.onRespond} describeRequest={props.describeRequest} onCancelAgent={cancel} />
                        ))}
                    </details>
                )}
            </div>
        );
    };
}, { name: 'ToolCall.Agent' });

export const ToolCall = component<ToolCallProps>(({ props }) => {
    return () => {
        const p = props.part;
        const request: OpenRequest | undefined = p.requestId !== undefined ? props.transcript?.requests[p.requestId] : undefined;
        const awaiting = request !== undefined && request.kind === 'permission';
        const streaming = p.status === 'streaming';
        const sig = streaming ? `${oneLine(p.inputText ?? '')}…` : signature(p.input);
        const output = streaming ? undefined : outputText(p);
        const view = toolCallState(p, { awaiting, emptyOutput: output === undefined && reportedOutput(p) });
        const error = nonBlank(p.error);
        const agent = p.agentId !== undefined ? props.transcript?.agents[p.agentId] : undefined;
        // The refined phase reads as meta when the caller gave none: "awaiting approval", "cancelled", "done, no output".
        const meta = nonBlank(props.meta) ?? (view.label === view.phase ? undefined : view.label);
        return (
            <div data-scope={SCOPE} data-part="root" data-state={view.state}>
                <div data-scope={SCOPE} data-part="header">
                    <span data-scope={SCOPE} data-part="icon">
                        <Icon name={toolIcon(p.name)} size={15} />
                    </span>
                    <code data-scope={SCOPE} data-part="name">{p.title ?? p.name}</code>
                    {sig !== '' && (
                        <span data-scope={SCOPE} data-part="signature" title={sig}>
                            {sig}
                        </span>
                    )}
                    {meta && <span data-scope={SCOPE} data-part="meta">{meta}</span>}
                    <span data-scope={SCOPE} data-part="status" title={view.label}>
                        <StatusPill status={PILL[view.phase]} />
                    </span>
                </div>
                {!streaming && sig !== '' && <InputBlock text={inputText(p.input)} />}
                {output !== undefined && <OutputBlock text={output} logHref={props.logHref} />}
                {error && <p data-scope={SCOPE} data-part="error">{error}</p>}
                {awaiting && props.onRespond && <ApprovalPrompt request={request!} onRespond={props.onRespond} {...props.describeRequest?.(request!)} toolName={p.name} input={p.input} />}
                {agent && <AgentCard agent={agent} transcript={props.transcript} onRespond={props.onRespond} describeRequest={props.describeRequest} onCancelAgent={props.onCancelAgent} />}
            </div>
        );
    };
}, { name: 'ToolCall' });
