/**
 * `ToolCall` — one tool part as the handoff's card (`ai-tool-call`,
 * `docs/design/HANDOFF.md` → "Tool call `data-state`"): the header carries
 * an icon in the state colour, the tool name, the signature truncated, an
 * optional meta (duration, diff stat, task id) and the status pill; the
 * input folds in a zero `Collapsible`, the output is a well (a Collapsible
 * too) that folds past six lines behind "Show N more lines" and links to the
 * session log past two hundred; an error line; the approval card in place
 * while the call waits on the operator; the sub-agent card when the call
 * spawned one. A call whose result is a pull request carries the live
 * `PullCard` in place of the well (PRJ-10): it re-renders from the record,
 * so it updates in place rather than posting a message per check. Given the
 * page's `pullLinks.usePull`, the card reads the PR live by repo and number
 * (#935) — `pull_report`'s answer included, read or not yet.
 *
 * `data-state` is zero's governed lifecycle (`./tool-state`): `loading`
 * while pending — arguments still streaming, or awaiting approval —
 * `running`, `complete`, `error`, `denied` and `cancelled`. The pill says
 * the phase in the handoff's words (PENDING, RUNNING, DONE, ERROR, DENIED);
 * a refined phase (`awaiting approval`, `cancelled`, `no output`) is the
 * meta text when the caller gave none.
 */
import { component, type Define } from '@sigx/runtime-core';
import { agentMessages, toolOutput } from '@sigx/ai-agent';
import type { PullRequest } from '@agentic/core';
import { Collapsible } from '@sigx/zero';
import type { AgentState, AgentTranscript, OpenRequest, ToolPartState } from '@sigx/ai-agent/app';
import { Button } from '../kit/Button.js';
import { Icon, type IconName } from '../kit/icons.js';
import { StatusPill } from '../kit/StatusPill.js';
import { PullCard, isPullRequest } from '../projects/PullCard.js';
import { aiToolCallAnatomy } from './anatomy.js';
import { followDisclosure } from './disclosure.js';
import { ApprovalPrompt, type ApprovalPromptProps, type RespondFn } from './ApprovalPrompt.js';
import { QuestionPrompt } from './QuestionPrompt.js';
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

/** A page's link about a call, in its header — "View diff" to the file an edit touched. */
export interface ToolLink {
    readonly label: string;
    readonly href: string;
}

/** A pull request a call names: its repo (`owner/name`, when known) and number. */
export interface PullRef {
    readonly repo?: string;
    readonly number: number;
}

/**
 * The live read of a pull request (#935): called once in the chat card's setup, it returns a reactive getter of the
 * record as the page's Pulls store holds it, so one card follows the PR and updates in place.
 */
export type UsePullFn = (ref: PullRef) => () => PullRequest | undefined;

/**
 * Where a pull request a call returned leads: the PR page and its diff (`chat` card); the provider's page by default.
 * `usePull`, when the page gives it, makes the card live: it resolves the PR by repo and number and follows it.
 */
export type PullLinksFn = ((pull: PullRequest) => { readonly href?: string; readonly diffHref?: string; readonly agentName?: string } | undefined) & {
    readonly usePull?: UsePullFn;
};

/** A call's output as a value: the output itself, or its JSON object text. */
function outputValue(p: ToolPartState): unknown {
    if (p.status === 'streaming' || !reportedOutput(p)) return undefined;
    const out: unknown = toolOutput(p);
    if (typeof out === 'string' && out.trimStart().startsWith('{')) {
        try {
            return JSON.parse(out);
        } catch {
            return undefined;
        }
    }
    return out;
}

/** The pull request a call's result is — the output itself, or its JSON text — else `undefined`. */
export function pullOf(p: ToolPartState): PullRequest | undefined {
    const out = outputValue(p);
    return isPullRequest(out) ? out : undefined;
}

/** The tool whose answer names the PR an agent opened, read or not (`pull_report`, #793). */
export const PULL_REPORT_TOOL = 'pull_report';

/** The pull request a call names: a full record, or `pull_report`'s answer (`{number, repo}`) before the PR is read. */
export function pullRefOf(p: ToolPartState): PullRef | undefined {
    const out = outputValue(p);
    if (isPullRequest(out)) return { repo: out.repo, number: out.number };
    if (p.name !== PULL_REPORT_TOOL || !out || typeof out !== 'object') return undefined;
    const { number, repo } = out as { number?: unknown; repo?: unknown };
    if (typeof number !== 'number') return undefined;
    return { number, ...(typeof repo === 'string' ? { repo } : {}) };
}

/** The links a page puts on a call's card; none by default. */
export type ToolLinksFn = (part: ToolPartState) => readonly ToolLink[] | undefined;

/** What the page knows about a request that the transcript does not: the rule it matched, who asked, where it runs, the delegation path, a settled decision. */
export type ApprovalContext = Pick<ApprovalPromptProps, 'toolName' | 'input' | 'rule' | 'requestedBy' | 'environment' | 'via' | 'decision' | 'compact'>;
/** A request's context as the page describes it: the approval rows, and for a question whether its asker stopped waiting (#285). */
export type RequestContext = ApprovalContext & { readonly stale?: boolean };
/** Resolves the approval card's context rows for a request (`docs/design/HANDOFF.md` → `ai-approval`); absent = the bare card. */
export type DescribeRequestFn = (request: OpenRequest) => RequestContext | undefined;

/** The approval card's rows of a request's context — without what only a question reads. */
export function approvalContext(context: RequestContext | undefined): ApprovalContext | undefined {
    if (!context) return undefined;
    const { stale: _stale, ...rows } = context;
    return rows;
}

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
    /** The page's links about this call ("View diff"), in the header before the meta. */
    & Define.Prop<'links', readonly ToolLink[], false>
    /** The links of a pull request the call returned. */
    & Define.Prop<'pullLinks', PullLinksFn, false>
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

/** A block's fold: a zero Collapsible whose trigger is the chevron and a mono label. */
const Fold = component<Define.Prop<'label', string, true> & Define.Prop<'defaultOpen', boolean, false> & Define.Slot<'default'>>(({ props, slots }) => () => (
    <Collapsible.Root defaultOpen={props.defaultOpen}>
        <Collapsible.Trigger>
            {props.label}
        </Collapsible.Trigger>
        <Collapsible.Panel>{slots.default?.()}</Collapsible.Panel>
    </Collapsible.Root>
), { name: 'ToolCall.Fold' });

/** The input block: folded by default; the Collapsible keeps the reader's toggle across re-renders. */
const InputBlock = component<Define.Prop<'text', string, true>>(({ props }) => () => (
    <div data-scope={SCOPE} data-part="input">
        <Fold label="input">
            <pre>{props.text}</pre>
        </Fold>
    </div>
), { name: 'ToolCall.Input' });

/**
 * The output well: open by default, the first six lines, then "Show N more
 * lines"; past two hundred lines the rest lives in the session log.
 */
const OutputBlock = component<Define.Prop<'text', string, true> & Define.Prop<'logHref', string, false>>(({ props, signal }) => {
    const st = signal({ expanded: false });
    return () => {
        const lines = props.text.split('\n');
        const total = lines.length;
        const capped = Math.min(total, OUTPUT_LOG);
        const shown = st.expanded ? lines.slice(0, capped) : lines.slice(0, Math.min(OUTPUT_FOLD, capped));
        const folded = capped - shown.length;
        const beyond = total - capped;
        return (
            <div data-scope={SCOPE} data-part="output">
                <Fold label="output" defaultOpen>
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
                </Fold>
            </div>
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
    const isRunning = (): boolean => props.agent.status === 'running' || props.agent.status === 'paused';
    // Its work is open while it runs and folds once it is done — unless the reader toggled it.
    const work = followDisclosure(isRunning);
    return () => {
        const { agent, transcript } = props;
        const running = isRunning();
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
                    <Collapsible.Root
                        model={() => work.open}
                        onOpenChange={() => {
                            work.touched = true;
                        }}
                    >
                        <Collapsible.Trigger>
                            {running ? 'Working…' : `Its work (${messages.length} message${messages.length === 1 ? '' : 's'})`}
                        </Collapsible.Trigger>
                        <Collapsible.Panel>
                            {messages.map((m) => (
                                <Message key={m.id} message={m} transcript={transcript} onRespond={props.onRespond} describeRequest={props.describeRequest} onCancelAgent={cancel} />
                            ))}
                        </Collapsible.Panel>
                    </Collapsible.Root>
                )}
            </div>
        );
    };
}, { name: 'ToolCall.Agent' });

/**
 * The chat card, live (#935): the page's `usePull` read of the PR (opened once, here in setup) wins over the snapshot the
 * call returned, so the card updates in place as the Pulls store reads the PR. Nothing to show yet → the output well.
 */
const LivePullCard = component<
    & Define.Prop<'pullRef', PullRef, true>
    & Define.Prop<'snapshot', PullRequest, false>
    & Define.Prop<'pullLinks', PullLinksFn, false>
    & Define.Prop<'output', string, false>
    & Define.Prop<'logHref', string, false>
>(({ props }) => {
    const usePull = props.pullLinks?.usePull;
    const live = usePull ? usePull(props.pullRef) : () => undefined;
    return () => {
        const pull = live() ?? props.snapshot;
        if (pull) return <PullCard pull={pull} surface="chat" {...pullCardLinks(pull, props.pullLinks)} />;
        return props.output !== undefined ? <OutputBlock text={props.output} logHref={props.logHref} /> : null;
    };
}, { name: 'ToolCall.LivePull' });

/** The chat card's links: the page's, else the provider's page. */
function pullCardLinks(pull: PullRequest, links?: PullLinksFn): { href: string; diffHref?: string; agentName?: string } {
    const l = links?.(pull);
    return { href: l?.href ?? pull.url, ...(l?.diffHref ? { diffHref: l.diffHref } : {}), ...(l?.agentName ? { agentName: l.agentName } : {}) };
}

export const ToolCall = component<ToolCallProps>(({ props }) => {
    return () => {
        const p = props.part;
        const request: OpenRequest | undefined = p.requestId !== undefined ? props.transcript?.requests[p.requestId] : undefined;
        const awaiting = request !== undefined && request.kind === 'permission';
        const asking = request !== undefined && request.kind === 'input';
        const streaming = p.status === 'streaming';
        const sig = streaming ? `${oneLine(p.inputText ?? '')}…` : signature(p.input);
        const pull = pullOf(p);
        // A PR the page can read live gets the card even before the call's own answer carries the record.
        const ref = streaming ? undefined : pullRefOf(p);
        const card = ref && (pull || props.pullLinks?.usePull) ? ref : undefined;
        const output = streaming || pull ? undefined : outputText(p);
        const view = toolCallState(p, { awaiting, emptyOutput: output === undefined && !pull && reportedOutput(p) });
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
                    {props.links?.map((l) => (
                        <a key={l.href} data-scope={SCOPE} data-part="link" href={l.href}>
                            {l.label}
                        </a>
                    ))}
                    {meta && <span data-scope={SCOPE} data-part="meta">{meta}</span>}
                    <span data-scope={SCOPE} data-part="status" title={view.label}>
                        <StatusPill status={PILL[view.phase]} />
                    </span>
                </div>
                {!streaming && sig !== '' && <InputBlock text={inputText(p.input)} />}
                {card
                    ? <LivePullCard key={`${card.repo ?? ''}#${card.number}${props.pullLinks?.usePull ? ':live' : ''}`} pullRef={card} snapshot={pull} pullLinks={props.pullLinks} output={output} logHref={props.logHref} />
                    : output !== undefined && <OutputBlock text={output} logHref={props.logHref} />}
                {error && <p data-scope={SCOPE} data-part="error">{error}</p>}
                {awaiting && props.onRespond && <ApprovalPrompt request={request!} onRespond={props.onRespond} {...approvalContext(props.describeRequest?.(request!))} toolName={p.name} input={p.input} />}
                {asking && props.onRespond && <QuestionPrompt request={request!} onRespond={props.onRespond} requestedBy={props.describeRequest?.(request!)?.requestedBy} stale={props.describeRequest?.(request!)?.stale} />}
                {agent && <AgentCard agent={agent} transcript={props.transcript} onRespond={props.onRespond} describeRequest={props.describeRequest} onCancelAgent={props.onCancelAgent} />}
            </div>
        );
    };
}, { name: 'ToolCall' });
