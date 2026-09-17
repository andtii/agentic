import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, Button, StatusPill } from '@agentic/ui';
import { agentNamed, type MockChatSummary } from '../../mock/workspace';

export type ChatListProps =
    & Define.Prop<'chats', readonly MockChatSummary[], true>
    & Define.Prop<'currentId', string>
    /** Full-width variant on `/chats`. */
    & Define.Prop<'wide', boolean>;

/** Member tiles stack to four, then `+N` in mono (docs/design/HANDOFF.md → Edge cases). */
export const MemberTiles = component<{ agentIds: readonly string[]; size?: 18 | 20 | 22 | 28 }>(({ props }) => () => {
    const shown = props.agentIds.slice(0, 4);
    const more = props.agentIds.length - shown.length;
    return (
        <span data-member-tiles>
            {shown.map((id) => {
                const a = agentNamed(id);
                return <AgentTile name={a.name} hue={a.hue} size={props.size ?? 18} />;
            })}
            {more > 0 ? <span data-member-more>+{more}</span> : null}
        </span>
    );
});

/**
 * The chat list: the left column of `/chats/:id` and the whole of `/chats`.
 * Title, unread badge, member tiles + last line, an amber pill while an
 * approval is open in the chat.
 */
export const ChatList = component<ChatListProps>(({ props }) => () => (
    <nav data-chat-list data-wide={props.wide ? '' : undefined} aria-label="Chats">
        <div data-chat-search>
            <label data-visually-hidden for="chat-search">Search chats</label>
            <input id="chat-search" type="search" placeholder="Search chats" data-scope="input" data-part="input" />
            <Button intent="icon" icon="plus" label="New chat" />
        </div>
        <ul data-chat-rows>
            {props.chats.map((chat) => (
                <li data-chat-row data-current={chat.id === props.currentId ? '' : undefined} data-waiting={chat.waiting ? '' : undefined}>
                    <Link to={`/chats/${chat.id}`} aria-current={chat.id === props.currentId ? 'page' : undefined}>
                        <span data-chat-row-head>
                            <span data-chat-title>{chat.title}</span>
                            {chat.waiting ? <StatusPill status="approval" label={String(chat.unread || 1)} /> : chat.unread ? <span data-chat-unread>{chat.unread}</span> : null}
                        </span>
                        <span data-chat-row-line>
                            <MemberTiles agentIds={chat.members.map((m) => m.agentId)} />
                            <span data-chat-last>{chat.lastLine}</span>
                        </span>
                    </Link>
                </li>
            ))}
        </ul>
    </nav>
));
