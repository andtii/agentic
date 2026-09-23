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
 */
import { component, type Define } from '@sigx/runtime-core';
import type { AgentMessage, AgentPart, AgentTranscript, ToolPartState } from '@sigx/ai-agent/app';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { EnvironmentLine, type EnvironmentParts } from '../kit/EnvironmentLine.js';
import { Icon } from '../kit/icons.js';
import { StatusPill } from '../kit/StatusPill.js';
import { aiMessageAnatomy } from './anatomy.js';
import type { RespondFn } from './ApprovalPrompt.js';
import { Reasoning } from './Reasoning.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';
import { ToolCall, type DescribeRequestFn, type ToolLinksFn, type ToolMetaFn } from './ToolCall.js';
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
    /** Where the row ran (EXE-06) — rendered as the kit's environment line. */
    readonly environment?: EnvironmentParts;
    /** Wall-clock time of the row, already formatted in the workspace zone (`14:02`), with the ISO datetime for the `<time>` element. */
    readonly time?: { readonly text: string; readonly dateTime?: string };
}

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
    & Define.Prop<'logHref', string, false>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'describeRequest', DescribeRequestFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>;

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

export const Message = component<MessageProps>(({ props }) => {
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
        const runs = runsOf(message.parts, from, to);
        const env = author?.environment;
        return (
            <div data-scope={SCOPE} data-part="root" data-placement={placement}>
                <span data-scope={SCOPE} data-part="avatar">
                    <AgentTile name={name} hue={author?.hue} person={person} size={32} />
                </span>
                <div data-scope={SCOPE} data-part="meta">
                    <span data-scope={SCOPE} data-part="name">{name}</span>
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
                                logHref={props.logHref}
                                onRespond={props.onRespond}
                                describeRequest={props.describeRequest}
                                onCancelAgent={props.onCancelAgent}
                            />
                        ))}
                    </div>
                ))}
                {partial && <span data-scope={SCOPE} data-part="footer">{`parts ${from + 1}–${to} of ${message.parts.length}`}</span>}
            </div>
        );
    };
}, { name: 'Message' });
