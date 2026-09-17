/**
 * `ToolCall` — one tool part as a card (`ai-tool-call`): the signature and
 * status in the header, the input and output as collapsible blocks, an error
 * line, the approval prompt in place while the call waits on the operator,
 * and the sub-agent card when the call spawned one.
 *
 * `data-state` is the governed lifecycle (`./tool-state`): `loading` while
 * pending — arguments still streaming, or awaiting approval — `active` while
 * running, `complete`, `error`, and `closed` for a denied call.
 */
import { component, type Define } from '@sigx/runtime-core';
import { agentMessages } from '@sigx/ai-agent';
import type { AgentState, AgentTranscript, OpenRequest, ToolPartState } from '@sigx/ai-agent/app';
import { aiToolCallAnatomy } from './anatomy.js';
import { ApprovalPrompt, type RespondFn } from './ApprovalPrompt.js';
import { Message } from './Message.js';
import { agentState, toolCallState } from './tool-state.js';
import { inputText, nonBlank, oneLine, outputText, reportedOutput, signature } from './text.js';

const SCOPE = aiToolCallAnatomy.scope;

/** What every card in a thread shares: the transcript (for sub-agents), the way to answer a request, the way to stop an agent. */
export interface ThreadContextProps {
    readonly transcript?: AgentTranscript;
    readonly onRespond?: RespondFn;
    /** Offered only when the agent controls its sub-agents (`capabilities.subagents === 'control'`). */
    readonly onCancelAgent?: (agentId: string) => void;
}

export type ToolCallProps =
    & Define.Prop<'part', ToolPartState, true>
    & Define.Prop<'transcript', AgentTranscript, false>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>;

/** A collapsible io block on a native `<details>`; the reader's toggle wins over the default. */
const IoBlock = component<Define.Prop<'part', 'input' | 'output', true> & Define.Prop<'text', string, true> & Define.Prop<'defaultOpen', boolean, false>>(({ props, signal }) => {
    const st = signal({ open: undefined as boolean | undefined });
    return () => {
        const open = st.open ?? props.defaultOpen ?? false;
        return (
            <details
                data-scope={SCOPE}
                data-part={props.part}
                data-state={open ? 'open' : 'closed'}
                open={open}
                onToggle={(e: Event) => {
                    st.open = (e.currentTarget as HTMLDetailsElement).open;
                }}
            >
                <summary>{props.part}</summary>
                <pre>{props.text}</pre>
            </details>
        );
    };
}, { name: 'ToolCall.Io' });

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
                        <button type="button" onClick={() => cancel(agent.agentId)}>
                            Cancel
                        </button>
                    )}
                </p>
                {summary && <p>{summary}</p>}
                {error && <p data-scope={SCOPE} data-part="error">{error}</p>}
                {messages.length > 0 && (
                    <details open={running}>
                        <summary>{running ? 'Working…' : `Its work (${messages.length} message${messages.length === 1 ? '' : 's'})`}</summary>
                        {messages.map((m) => (
                            <Message key={m.id} message={m} transcript={transcript} onRespond={props.onRespond} onCancelAgent={cancel} />
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
        return (
            <div data-scope={SCOPE} data-part="root" data-state={view.state}>
                <div data-scope={SCOPE} data-part="header">
                    <code>
                        {p.title ?? p.name}({sig})
                    </code>
                    <span data-scope={SCOPE} data-part="status">{view.label}</span>
                </div>
                {!streaming && sig !== '' && <IoBlock part="input" text={inputText(p.input)} />}
                {output !== undefined && <IoBlock part="output" text={output} defaultOpen />}
                {error && <p data-scope={SCOPE} data-part="error">{error}</p>}
                {awaiting && props.onRespond && <ApprovalPrompt request={request!} onRespond={props.onRespond} toolName={p.name} />}
                {agent && <AgentCard agent={agent} transcript={props.transcript} onRespond={props.onRespond} onCancelAgent={props.onCancelAgent} />}
            </div>
        );
    };
}, { name: 'ToolCall' });
