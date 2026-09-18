import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, Button, StatusPill } from '@agentic/ui';
import { agentNamed, type MockChatSummary } from '../../mock/workspace';
import type { AgentLookup } from './live';

export type ChatListProps =
    & Define.Prop<'chats', readonly MockChatSummary[], true>
    & Define.Prop<'currentId', string>
    /** Full-width variant on `/chats`. */
    & Define.Prop<'wide', boolean>
    /** Who an agent id is; the mock workspace's `agentNamed` by default, the live directory on the wired pages (#34). */
    & Define.Prop<'lookup', AgentLookup>
    /** The "+" button: opens the new-chat dialog. */
    & Define.Event<'newChat'>;

/** Member tiles stack to four, then `+N` in mono (docs/design/HANDOFF.md → Edge cases). */
export const MemberTiles = component<{ agentIds: readonly string[]; size?: 18 | 20 | 22 | 28; lookup?: AgentLookup }>(({ props }) => () => {
    const shown = props.agentIds.slice(0, 4);
    const more = props.agentIds.length - shown.length;
    const lookup = props.lookup ?? agentNamed;
    return (
        <span data-member-tiles>
            {shown.map((id) => {
                const a = lookup(id);
                return <AgentTile name={a.name} hue={a.hue} size={props.size ?? 18} />;
            })}
            {more > 0 ? <span data-member-more>+{more}</span> : null}
        </span>
    );
});

/** The rows a search keeps: every word of `q` somewhere in the title or the last line, case-insensitive; a blank search keeps all. */
export function matchingChats(chats: readonly MockChatSummary[], q: string): readonly MockChatSummary[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return chats;
    return chats.filter((c) => {
        const text = `${c.title}\n${c.lastLine}`.toLowerCase();
        return words.every((w) => text.includes(w));
    });
}

/**
 * The chat list: the left column of `/chats/:id` and the whole of `/chats`.
 * Title, unread badge, member tiles + last line, an amber pill while an
 * approval is open in the chat. The search box filters the rows by title
 * and last line as you type.
 */
export const ChatList = component<ChatListProps>(({ props, emit }) => {
    const st = signal({ q: '' });
    return () => (
    <nav data-chat-list data-wide={props.wide ? '' : undefined} aria-label="Chats">
        <div data-chat-search>
            <label data-visually-hidden for="chat-search">Search chats</label>
            <input id="chat-search" type="search" placeholder="Search chats" data-scope="input" data-part="input" value={st.q} onInput={(e: Event) => { st.q = (e.target as HTMLInputElement).value; }} />
            <Button intent="icon" icon="plus" label="New chat" onClick={() => emit('newChat')} />
        </div>
        <ul data-chat-rows>
            {matchingChats(props.chats, st.q).map((chat) => (
                <li data-chat-row data-current={chat.id === props.currentId ? '' : undefined} data-waiting={chat.waiting ? '' : undefined}>
                    <Link to={`/chats/${chat.id}`} aria-current={chat.id === props.currentId ? 'page' : undefined}>
                        <span data-chat-row-head>
                            <span data-chat-title>{chat.title}</span>
                            {chat.waiting ? <StatusPill status="approval" label={String(chat.unread || 1)} /> : chat.unread ? <span data-chat-unread>{chat.unread}</span> : null}
                        </span>
                        <span data-chat-row-line>
                            <MemberTiles agentIds={chat.members.map((m) => m.agentId)} lookup={props.lookup} />
                            <span data-chat-last>{chat.lastLine}</span>
                        </span>
                    </Link>
                </li>
            ))}
        </ul>
    </nav>
    );
});
