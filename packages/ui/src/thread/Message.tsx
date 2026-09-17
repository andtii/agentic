/**
 * `Message` — one transcript message as a row (`ai-message`), composed over
 * zero's `Chat`: the user's own rows sit at the logical `end`, everyone
 * else's at the reading `start`. The attribution badge (CHT-02) names the
 * author on every row; a sub-agent's rows name the agent.
 *
 * Parts render in reading order, grouped into `body` (text, reasoning,
 * attachments) and `tools` (tool cards) runs. Each part is its own
 * component, so a `part-delta` re-runs one part's render and never this
 * list. `from` / `to` window the parts: the thread hands a long message the
 * slice it has room for, and the footer says so.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Badge, Chat } from '@sigx/zero';
import type { AgentMessage, AgentPart, AgentTranscript } from '@sigx/ai-agent/app';
import { aiMessageAnatomy } from './anatomy.js';
import type { RespondFn } from './ApprovalPrompt.js';
import { Reasoning } from './Reasoning.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';
import { ToolCall } from './ToolCall.js';
import { initials, nonBlank } from './text.js';

const SCOPE = aiMessageAnatomy.scope;

export type MessageProps =
    & Define.Prop<'message', AgentMessage, true>
    /** The part slice to render — `[from, to)`; the whole message by default. */
    & Define.Prop<'from', number, false>
    & Define.Prop<'to', number, false>
    & Define.Prop<'transcript', AgentTranscript, false>
    & Define.Prop<'onRespond', RespondFn, false>
    & Define.Prop<'onCancelAgent', (agentId: string) => void, false>;

/** The display name a row is attributed to. */
export function authorOf(message: AgentMessage): string {
    return nonBlank(message.author) ?? nonBlank(message.actor) ?? (message.role === 'user' ? 'You' : 'Assistant');
}

const Part = component<Define.Prop<'part', AgentPart, true> & Define.Prop<'transcript', AgentTranscript, false> & Define.Prop<'onRespond', RespondFn, false> & Define.Prop<'onCancelAgent', (agentId: string) => void, false>>(({ props }) => {
    return () => {
        const p = props.part;
        switch (p.type) {
            case 'text':
                return <StreamingMarkdown text={p.text} />;
            case 'reasoning':
                return <Reasoning part={p} reasoningTokens={props.transcript?.usage?.reasoningTokens} />;
            case 'tool':
                return <ToolCall part={p} transcript={props.transcript} onRespond={props.onRespond} onCancelAgent={props.onCancelAgent} />;
            case 'image':
                return <code>{p.mediaType}</code>;
            case 'file':
                return <code>{p.filename ?? p.mediaType}</code>;
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
        const author = authorOf(message);
        const from = Math.max(0, props.from ?? 0);
        const to = Math.min(message.parts.length, props.to ?? message.parts.length);
        const partial = from > 0 || to < message.parts.length;
        const runs = runsOf(message.parts, from, to);
        return (
            <div data-scope={SCOPE} data-part="root" data-placement={placement}>
                <Chat.Root placement={placement} color={own ? 'primary' : undefined}>
                    <Chat.Avatar>
                        <span data-scope={SCOPE} data-part="avatar" aria-hidden="true">{initials(author)}</span>
                    </Chat.Avatar>
                    <Chat.Header>
                        <span data-scope={SCOPE} data-part="meta">
                            <Badge.Root size="sm" color={own ? 'primary' : 'neutral'}>{author}</Badge.Root>
                        </span>
                    </Chat.Header>
                    <Chat.Bubble>
                        {runs.map((run) => (
                            <div key={`${run.kind}:${run.parts[0]!.index}`} data-scope={SCOPE} data-part={run.kind}>
                                {run.parts.map(({ index, part }) => (
                                    <Part key={index} part={part} transcript={props.transcript} onRespond={props.onRespond} onCancelAgent={props.onCancelAgent} />
                                ))}
                            </div>
                        ))}
                    </Chat.Bubble>
                    {partial && (
                        <Chat.Footer>
                            <span data-scope={SCOPE} data-part="footer">{`parts ${from + 1}–${to} of ${message.parts.length}`}</span>
                        </Chat.Footer>
                    )}
                </Chat.Root>
            </div>
        );
    };
}, { name: 'Message' });
