/**
 * `Message` — one transcript message as a row (`ai-message`): the identity
 * tile top-aligned, then the meta line (name, environment line, time, the
 * STREAMING pill while the session is mid-turn), the body and the tool
 * cards, in reading order (`docs/design/HANDOFF.md` → `ai-message`). The
 * user's own rows sit at the logical `end`, everyone else's at the reading
 * `start`; the name on every row is the attribution (CHT-02), and a
 * sub-agent's rows name the agent.
 *
 * Who an author IS — the identity hue, the environment the row ran in, the
 * time — is not in the transcript: the page resolves it through `describe`
 * (`Thread`) or passes an `author` here. Without one the row still
 * attributes: the name from the message, a muted tile.
 *
 * Parts render in reading order, grouped into `body` (text, reasoning,
 * attachments) and `tools` (tool cards) runs. Each part is its own
 * component, so a `part-delta` re-runs one part's render and never this
 * list. `from` / `to` window the parts: the thread hands a long message the
 * slice it has room for, and the footer says so.
 *
 * `detail` picks how much of the work shows (#1054, `docs/design/chat-modes/HANDOFF.md` →
 * "Detail levels"): `raw` (the default) is every tool card in full, as above; `steps` folds the
 * message's tool calls into one steps box (`Steps`) after its prose — from `steps` on the message
 * when the chat entry carries them, else read off its tool parts (`stepsFromToolParts`); `messages`
 * drops the tool calls. Both keep an open approval or question in the thread, and both put the
 * reasoning behind a `thought` chip on the right of the meta line that opens it inline.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { AgentMessage, AgentPart, AgentTranscript, ReasoningPartState, ToolPartState } from '@sigx/ai-agent/app';
import type { TurnSteps } from '@agentic/core';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { EnvironmentLine, type EnvironmentParts } from '../kit/EnvironmentLine.js';
import { Icon } from '../kit/icons.js';
import { StatusPill } from '../kit/StatusPill.js';
import { aiMessageAnatomy } from './anatomy.js';
import { ApprovalPrompt, type RespondFn } from './ApprovalPrompt.js';
import { QuestionPrompt } from './QuestionPrompt.js';
import { Reasoning } from './Reasoning.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';
import { ToolCall, approvalContext, type DescribeRequestFn, type PullLinksFn, type ToolLinksFn, type ToolMetaFn } from './ToolCall.js';
import { Steps, type StepHrefFn } from '../transcript/Steps.js';
import { stepsFromToolParts } from '../transcript/step-model.js';
import { formatBytes, nonBlank } from './text.js';

const SCOPE = aiMessageAnatomy.scope;

/** What the page knows about a row's author that the transcript does not. */
export interface MessageAuthor {
    /** The display name; the message's own attribution when absent. */
    readonly name?: string;
    /** The agent's identity slot; people and unknown agents get the muted tile. */
    readonly hue?: AgentHue;
    /** A person: circle tile. The user's own rows are people by default. */
    readonly person?: boolean;
    /** The project the author comes from — a visiting manager's (#870): a chip after the name. */
    readonly project?: string;
    /** What the author is here, after the name (`project manager, visiting`). */
    readonly role?: string;
    /** Where the row ran (EXE-06) — rendered as the kit's environment line. */
    readonly environment?: EnvironmentParts;
    /** Wall-clock time of the row, already formatted in the workspace zone (`14:02`), with the ISO datetime for the `<time>` element. */
    readonly time?: { readonly text: string; readonly dateTime?: string };
    /** How long the row's reasoning took, in seconds, when known: the chip's `thought 6s`. */
    readonly thoughtSeconds?: number;
}

/** How much of an agent's work the thread shows (#1054): prose only, prose and steps boxes, or every tool card. */
export type DetailLevel = 'messages' | 'steps' | 'raw';

/** A message whose chat entry carries its turn's steps (`ChatEntry` `msg.steps`, #1053). */
export type StepsMessage = AgentMessage & { readonly steps?: TurnSteps };

export type MessageProps =
    & Define.Prop<'message', AgentMessage, true>
    /** The part slice to render — `[from, to)`; the whole message by default. */
    & Define.Prop<'from', number, false>
    & Define.Prop<'to', number, false>
    & Define.Prop<'transcript', AgentTranscript, false>
    & Define.Prop<'author', MessageAuthor, false>
    /** The session is mid-turn on this row: the STREAMING pill. */
    & Define.Prop<'streaming', boolean, false>
    & Define.Prop<'toolMeta', ToolMetaFn, false>
    & Define.Prop<'toolLinks', ToolLinksFn, false>
    & Define.Prop<'pullLinks', PullLinksFn, false>
    & Define.Prop<'logHref', string, false>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'describeRequest', DescribeRequestFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>
    /** How much of the work shows; `raw` (every tool card) by default. */
    & Define.Prop<'detail', DetailLevel, false>
    /** The steps box's open state, controlled; absent, the box keeps its own. */
    & Define.Prop<'stepsOpen', boolean, false>
    /** The reader toggled the steps box. */
    & Define.Prop<'onStepsToggle', (open: boolean) => void, false>
    /** Where a step's full output lives (`Full output`). */
    & Define.Prop<'stepHref', StepHrefFn, false>;

/** The display name a row is attributed to. */
export function authorOf(message: AgentMessage): string {
    return nonBlank(message.author) ?? nonBlank(message.actor) ?? (message.role === 'user' ? 'You' : 'Assistant');
}

/** The image / file part shape — `@sigx/ai-agent`'s, plus the name and size a host may carry alongside. */
interface MediaPart {
    readonly mediaType: string;
    readonly data?: string;
    readonly url?: string;
    readonly filename?: string;
    readonly name?: string;
    readonly size?: number;
}

/** Where a media part's bytes are: its URL, else its base64 payload as a `data:` URL. */
export function mediaSrc(p: MediaPart): string | undefined {
    if (p.url) return p.url;
    return p.data ? `data:${p.mediaType};base64,${p.data}` : undefined;
}

/** The part's byte size: given, else decoded from the base64 payload's length. */
export function mediaSize(p: MediaPart): number | undefined {
    if (p.size !== undefined) return p.size;
    if (!p.data) return undefined;
    const pad = p.data.endsWith('==') ? 2 : p.data.endsWith('=') ? 1 : 0;
    return Math.floor((p.data.length * 3) / 4) - pad;
}

const mediaName = (p: MediaPart, fallback: string): string => nonBlank(p.filename) ?? nonBlank(p.name) ?? fallback;

type PartProps =
    & Define.Prop<'part', AgentPart, true>
    & Define.Prop<'transcript', AgentTranscript, false>
    & Define.Prop<'toolMeta', ToolMetaFn, false>
    & Define.Prop<'toolLinks', ToolLinksFn, false>
    & Define.Prop<'pullLinks', PullLinksFn, false>
    & Define.Prop<'logHref', string, false>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'describeRequest', DescribeRequestFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>;

const Part = component<PartProps>(({ props }) => {
    return () => {
        const p = props.part;
        switch (p.type) {
            case 'text':
                return <StreamingMarkdown text={p.text} />;
            case 'reasoning':
                return <Reasoning part={p} reasoningTokens={props.transcript?.usage?.reasoningTokens} />;
            case 'tool':
                return (
                    <ToolCall
                        part={p}
                        transcript={props.transcript}
                        meta={props.toolMeta?.(p as ToolPartState)}
                        links={props.toolLinks?.(p as ToolPartState)}
                        pullLinks={props.pullLinks}
                        logHref={props.logHref}
                        onRespond={props.onRespond}
                        describeRequest={props.describeRequest}
                        onCancelAgent={props.onCancelAgent}
                    />
                );
            case 'image': {
                const src = mediaSrc(p);
                if (!src) return <code>{p.mediaType}</code>;
                return (
                    <a data-scope={SCOPE} data-part="image" href={src} target="_blank" rel="noopener noreferrer">
                        <img src={src} alt={mediaName(p, 'image')} loading="lazy" decoding="async" />
                    </a>
                );
            }
            case 'file': {
                const src = mediaSrc(p);
                const name = mediaName(p, p.mediaType);
                if (!src) return <code>{name}</code>;
                const size = mediaSize(p);
                return (
                    <a data-scope={SCOPE} data-part="file" href={src} download={name}>
                        <Icon name="file" size={15} />
                        <span data-scope={SCOPE} data-part="file-name">{name}</span>
                        {size !== undefined && <span data-scope={SCOPE} data-part="file-size">{formatBytes(size)}</span>}
                    </a>
                );
            }
            default:
                return <code>{p.type}</code>;
        }
    };
}, { name: 'Message.Part' });

interface Run {
    readonly kind: 'body' | 'tools';
    readonly parts: { readonly index: number; readonly part: AgentPart }[];
}

/** The steps box's steps: the entry's own, else read off the tool parts; none when the message made no call. */
export function messageSteps(message: AgentMessage, transcript?: AgentTranscript): TurnSteps | undefined {
    const own = (message as StepsMessage).steps;
    if (own && own.total > 0) return own;
    const read = stepsFromToolParts(message, transcript);
    return read.total > 0 ? read : undefined;
}

/** The chip's text: `thinking…` while a reasoning part is open, else `thought` and the time when known. */
export function thoughtLabel(parts: readonly ReasoningPartState[], seconds?: number): string {
    if (parts.some((p) => p.done !== true)) return 'thinking…';
    return seconds !== undefined ? `thought ${Math.round(seconds)}s` : 'thought';
}

/** The prompt a tool call's open request needs in the thread when its card is not shown: the approval or the question. */
const OpenPrompt = component<
    & Define.Prop<'part', ToolPartState, true>
    & Define.Prop<'transcript', AgentTranscript, false>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'describeRequest', DescribeRequestFn, false>
>(({ props }) => () => {
    const p = props.part;
    const request = p.requestId !== undefined ? props.transcript?.requests[p.requestId] : undefined;
    const respond = props.onRespond;
    if (!request || !respond) return null;
    const context = props.describeRequest?.(request);
    if (request.kind === 'input') return <QuestionPrompt request={request} onRespond={respond} requestedBy={context?.requestedBy} stale={context?.stale} />;
    if (request.kind === 'permission') return <ApprovalPrompt request={request} onRespond={respond} {...approvalContext(context)} toolName={p.name} input={p.input} />;
    return null;
}, { name: 'Message.OpenPrompt' });

/** Consecutive parts of one kind become one `body` / `tools` element, so the reading order survives the grouping. */
function runsOf(parts: readonly AgentPart[], from: number, to: number): Run[] {
    const runs: Run[] = [];
    for (let index = from; index < to; index++) {
        const part = parts[index]!;
        const kind: Run['kind'] = part.type === 'tool' ? 'tools' : 'body';
        const last = runs[runs.length - 1];
        if (last && last.kind === kind) last.parts.push({ index, part });
        else runs.push({ kind, parts: [{ index, part }] });
    }
    return runs;
}

/** Folded detail: the prose and the attachments only, in reading order — one `body` run. */
function bodyRuns(parts: readonly AgentPart[], from: number, to: number): Run[] {
    const kept: Run['parts'] = [];
    for (let index = from; index < to; index++) {
        const part = parts[index]!;
        if (part.type !== 'reasoning' && part.type !== 'tool') kept.push({ index, part });
    }
    return kept.length ? [{ kind: 'body', parts: kept }] : [];
}

export const Message = component<MessageProps>(({ props, signal }) => {
    const st = signal({ thought: false });
    return () => {
        const message = props.message;
        const own = message.role === 'user';
        const placement = own ? 'end' : 'start';
        const author = props.author;
        const name = nonBlank(author?.name) ?? authorOf(message);
        const person = author?.person ?? own;
        const from = Math.max(0, props.from ?? 0);
        const to = Math.min(message.parts.length, props.to ?? message.parts.length);
        const partial = from > 0 || to < message.parts.length;
        const detail = props.detail ?? 'raw';
        const folded = detail !== 'raw';
        // Folded, the reasoning sits behind the chip and the tool calls in the steps box (or nowhere): the body keeps the rest.
        const runs = folded ? bodyRuns(message.parts, from, to) : runsOf(message.parts, from, to);
        const reasoning = folded ? message.parts.filter((p): p is ReasoningPartState => p.type === 'reasoning' && (p.done !== true || nonBlank(p.text) !== undefined)) : [];
        // The calls whose open request still needs the reader: their approval or question stays in the thread.
        const requests = props.transcript?.requests;
        const calls = folded && props.onRespond && requests
            ? message.parts.slice(from, to).filter((p): p is ToolPartState => p.type === 'tool' && p.requestId !== undefined && requests[p.requestId] !== undefined)
            : [];
        // The box closes the message: it renders with the slice that holds the last part.
        const steps = detail === 'steps' && to === message.parts.length ? messageSteps(message, props.transcript) : undefined;
        const env = author?.environment;
        return (
            <div data-scope={SCOPE} data-part="root" data-placement={placement}>
                <span data-scope={SCOPE} data-part="avatar">
                    <AgentTile name={name} hue={author?.hue} person={person} size={32} />
                </span>
                <div data-scope={SCOPE} data-part="meta">
                    <span data-scope={SCOPE} data-part="name">{name}</span>
                    {nonBlank(author?.project) && (
                        <span data-scope={SCOPE} data-part="project">
                            <Icon name="folder" size={12} />
                            {author!.project}
                        </span>
                    )}
                    {nonBlank(author?.role) && <span data-scope={SCOPE} data-part="role">{author!.role}</span>}
                    {env && (
                        <span data-scope={SCOPE} data-part="environment">
                            <EnvironmentLine machine={env.machine} runtime={env.runtime} account={env.account} tone="dim" />
                        </span>
                    )}
                    {author?.time && (
                        <time data-scope={SCOPE} data-part="time" dateTime={author.time.dateTime}>
                            {author.time.text}
                        </time>
                    )}
                    {props.streaming && <StatusPill status="streaming" />}
                    {reasoning.length > 0 && (
                        <button
                            type="button"
                            data-scope={SCOPE}
                            data-part="thought"
                            aria-expanded={st.thought ? 'true' : 'false'}
                            onClick={() => {
                                st.thought = !st.thought;
                            }}
                        >
                            <Icon name="brain" size={13} />
                            <span>{thoughtLabel(reasoning, author?.thoughtSeconds)}</span>
                        </button>
                    )}
                    {st.thought && reasoning.length > 0 && (
                        <div data-scope={SCOPE} data-part="thinking">
                            {reasoning.filter((p) => nonBlank(p.text) !== undefined).map((p) => (
                                <div key={p.id} data-scope="ai-reasoning" data-part="root">
                                    <div data-scope="ai-reasoning" data-part="body">
                                        <StreamingMarkdown text={p.text} done={p.done === true} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                {runs.map((run) => (
                    <div key={`${run.kind}:${run.parts[0]!.index}`} data-scope={SCOPE} data-part={run.kind}>
                        {run.parts.map(({ index, part }) => (
                            <Part
                                key={index}
                                part={part}
                                transcript={props.transcript}
                                toolMeta={props.toolMeta}
                                toolLinks={props.toolLinks}
                                pullLinks={props.pullLinks}
                                logHref={props.logHref}
                                onRespond={props.onRespond}
                                describeRequest={props.describeRequest}
                                onCancelAgent={props.onCancelAgent}
                            />
                        ))}
                    </div>
                ))}
                {(steps || calls.length > 0) && (
                    <div data-scope={SCOPE} data-part="tools">
                        {steps && <Steps steps={steps} open={props.stepsOpen} onToggle={props.onStepsToggle} fullHref={props.stepHref} />}
                        {calls.map((p) => (
                            <OpenPrompt key={p.callId} part={p} transcript={props.transcript} onRespond={props.onRespond} describeRequest={props.describeRequest} />
                        ))}
                    </div>
                )}
                {partial && <span data-scope={SCOPE} data-part="footer">{`parts ${from + 1}–${to} of ${message.parts.length}`}</span>}
            </div>
        );
    };
}, { name: 'Message' });
