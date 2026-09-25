import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { Select } from '@sigx/zero';
import { Badge, Field, Input, Menu } from '@sigx/zero-daisyui/components';
import { AgentTile, Button, ErrorNote, Icon, ProjectSquare, StatusPill } from '@agentic/ui';
import { agentNamed, type MockChatSummary } from '../../mock/workspace';
import { dataMode } from '../../data-mode';
import { mockArchive, setMockArchived, splitArchived, withMockArchive, type ArchiveRequest, type ChatListRow } from './archive';
import { groupChatsByProject, type ChatGroupProject } from './chat-groups';
import type { AgentLookup } from './live';

export type ChatListProps =
    & Define.Prop<'chats', readonly ChatListRow[], true>
    & Define.Prop<'currentId', string>
    /** Full-width variant on `/chats`. */
    & Define.Prop<'wide', boolean>
    /** Who an agent id is; the mock workspace's `agentNamed` by default, the live directory on the wired pages (#34). */
    & Define.Prop<'lookup', AgentLookup>
    /** The workspace's projects (#333): a filter above the rows; absent or empty, no filter. With `wide`, the rows are grouped by project (#732). */
    & Define.Prop<'projects', readonly ChatGroupProject[]>
    /** Why the last archive or restore failed (#884); shown under the rows. */
    & Define.Prop<'error', string>
    /** The "+" button: opens the new-chat dialog. */
    & Define.Event<'newChat'>
    /**
     * A row's menu (#884): archive the chat, or restore an archived one. On mock data the list applies it itself
     * (`archive.ts`); live, the page calls `Chat.archive` and the chat's next read moves the row.
     */
    & Define.Event<'archive', ArchiveRequest>;

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

/** The project filter's "All projects" item: never a project id (those are minted by `createId`), and not zero's empty "nothing chosen". */
export const ALL_PROJECTS = '*';

/** The "No project" group's key in the collapsed set: never a project id. */
const NO_PROJECT_KEY = '-';

/** The rows a search keeps: every word of `q` somewhere in the title or the last line, case-insensitive; a blank search keeps all. */
export function matchingChats<T extends MockChatSummary>(chats: readonly T[], q: string, projectId: string = ''): readonly T[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const inProject = projectId ? chats.filter((c) => c.projectId === projectId) : chats;
    if (!words.length) return inProject;
    return inProject.filter((c) => {
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
    // The project filter's model: a project id, or `ALL_PROJECTS` (zero's Select keeps `null` / `''` for "nothing chosen").
    const st = signal({ q: '', project: ALL_PROJECTS as string | null });
    const projectFilter = (): string => (st.project && st.project !== ALL_PROJECTS ? st.project : '');
    // Collapsed group keys on `/chats` (#732): a project id, or `NO_PROJECT_KEY`.
    const groups = signal({ collapsed: [] as readonly string[] });
    const toggleGroup = (key: string) => {
        groups.collapsed = groups.collapsed.includes(key) ? groups.collapsed.filter((k) => k !== key) : [...groups.collapsed, key];
    };
    // The archived group (#884) starts collapsed; `null` until toggled, so it opens by itself around the chat on screen.
    const archive = signal({ open: null as boolean | null });
    const setArchived = (id: string, archived: boolean): void => {
        if (dataMode() !== 'live') setMockArchived(id, archived);
        emit('archive', { id, archived });
    };
    /** The row's overflow menu: Archive on an open chat, Restore on an archived one. */
    const rowMenu = (chat: ChatListRow) => (
        <Menu.Root placement="bottom-end" onSelect={(v: string) => setArchived(chat.id, v === 'archive')}>
            <Menu.Trigger data-chat-row-menu="" aria-label={`More actions for ${chat.title}`}>
                <Icon name="menu" size={14} />
            </Menu.Trigger>
            <Menu.Popup data-chat-row-menu-popup="">
                {chat.archived
                    ? <Menu.Item value="restore" data-chat-restore="">Restore chat</Menu.Item>
                    : <Menu.Item value="archive" data-chat-archive="">Archive chat</Menu.Item>}
            </Menu.Popup>
        </Menu.Root>
    );
    const row = (chat: ChatListRow) => (
        <li data-chat-row data-current={chat.id === props.currentId ? '' : undefined} data-waiting={chat.waiting ? '' : undefined} data-archived={chat.archived ? '' : undefined} style="display:flex;align-items:flex-start">
            <Link to={`/chats/${chat.id}`} aria-current={chat.id === props.currentId ? 'page' : undefined} style="flex:1;min-inline-size:0">
                <span data-chat-row-head>
                    <span data-chat-title>{chat.title}</span>
                    {chat.waiting ? <StatusPill status="approval" label={String(chat.unread || 1)} /> : chat.unread ? <Badge.Root color="warning" size="sm" data-chat-unread="">{chat.unread}</Badge.Root> : null}
                </span>
                <span data-chat-row-line>
                    <MemberTiles agentIds={chat.members.map((m) => m.agentId)} lookup={props.lookup} />
                    <span data-chat-last>{chat.lastLine}</span>
                </span>
            </Link>
            {rowMenu(chat)}
        </li>
    );
    /** Every row as it stands: live, the chats' own flags; on mock data, with this visit's archives and restores. */
    const current = (): ChatListRow[] => (dataMode() === 'live' ? [...props.chats] : withMockArchive(props.chats, mockArchive.map));
    /** The collapsed "Archived" group under the list (#884): each row restores from its menu. */
    const archivedGroup = (chats: readonly ChatListRow[]) => {
        if (!chats.length) return null;
        const open = archive.open ?? chats.some((c) => c.id === props.currentId);
        return (
            <section data-chat-archived aria-label="Archived chats">
                <header data-chat-group-head style="display:flex;align-items:center;gap:var(--space-sm)">
                    <button type="button" data-chat-archived-toggle aria-expanded={open ? 'true' : 'false'} aria-controls={open ? 'chat-group-archived' : undefined} aria-label={`${open ? 'Collapse' : 'Expand'} archived chats`} onClick={() => { archive.open = !open; }}>
                        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                    </button>
                    <span data-chat-group-name>Archived</span>
                    <span data-chat-group-count>{chats.length}</span>
                </header>
                {open ? <ul data-chat-rows id="chat-group-archived">{chats.map(row)}</ul> : null}
            </section>
        );
    };
    const rows = () => {
        const { open: chats, archived } = splitArchived(matchingChats(current(), st.q, projectFilter()));
        // The column beside a chat stays one flat list; `/chats` groups by project once there are projects.
        if (!props.wide || !props.projects?.length) return <><ul data-chat-rows>{chats.map(row)}</ul>{archivedGroup(archived)}</>;
        return (
            <>
            <div data-chat-groups>
                {groupChatsByProject(chats, props.projects).map((group) => {
                    const key = group.key ?? NO_PROJECT_KEY;
                    const open = !groups.collapsed.includes(key);
                    const name = group.project?.name ?? 'No project';
                    const listId = `chat-group-${key}`;
                    return (
                        <section data-chat-group={key} aria-label={name}>
                            <header data-chat-group-head style="display:flex;align-items:center;gap:var(--space-sm)">
                                <button type="button" data-chat-group-toggle aria-expanded={open ? 'true' : 'false'} aria-controls={open ? listId : undefined} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} onClick={() => toggleGroup(key)}>
                                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                                </button>
                                {group.project ? <ProjectSquare name={group.project.name} id={group.project.id} color={group.project.color} size={20} /> : null}
                                {group.project
                                    ? <span data-chat-group-name><Link to={`/projects/${group.project.id}/chats`}>{name}</Link></span>
                                    : <span data-chat-group-name>{name}</span>}
                                <span data-chat-group-count>{group.chats.length}</span>
                            </header>
                            {open ? <ul data-chat-rows id={listId}>{group.chats.map(row)}</ul> : null}
                        </section>
                    );
                })}
            </div>
            {archivedGroup(archived)}
            </>
        );
    };
    return () => (
    <nav data-chat-list data-wide={props.wide ? '' : undefined} aria-label="Chats">
        <div data-chat-search>
            <Input.Root model={() => st.q} type="search" autocomplete="off">
                <Input.Label visuallyHidden>Search chats</Input.Label>
                <Input.Control>
                    <Input.Input placeholder="Search chats" />
                </Input.Control>
            </Input.Root>
            <Button intent="icon" icon="plus" label="New chat" onClick={() => emit('newChat')} />
        </div>
        {props.projects?.length ? (
            <div data-chat-project-filter>
                <Field.Root>
                    <Field.Label visuallyHidden>Project</Field.Label>
                    <Select.Root
                        model={() => st.project}
                        items={[{ id: ALL_PROJECTS, name: 'All projects' }, ...props.projects]}
                        itemValue={(p) => p.id}
                        itemLabel={(p) => p.name}
                        name="chat-project-filter"
                    />
                </Field.Root>
            </div>
        ) : null}
        {rows()}
        {props.error ? <ErrorNote data-chat-archive-error="">{props.error}</ErrorNote> : null}
    </nav>
    );
});
