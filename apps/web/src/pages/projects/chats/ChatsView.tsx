/**
 * The project Chats page's body (#731, PRJ-04), the same on mock data and live: the head (title, counts, search,
 * New chat), the defaults strip, the chats grouped by who acts next (`groups.ts`), the strip of chats outside every
 * project and its "Review and move" dialog. The page around it supplies the rows and does the move.
 */
import { component, signal, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { Checkbox } from '@sigx/zero-daisyui/components';
import type { ProjectRecord } from '@agentic/core';
import { AgentTile, Button, ErrorNote, FormDialog, Icon, SearchField, StatusPill } from '@agentic/ui';
import { settingsHref } from '../settings/tabs';
import type { AgentLookup } from '../../chat/live';
import { CHAT_GROUPS, GROUP_LABELS, chatDefaults, chatGroupOf, defaultsTail, groupChats, listOf, unassignedChats, type ChatGroup, type ProjectChatRow, type WorkChip } from './groups';
import { featureViewsOf } from '../features/registry';

export type ChatsViewProps =
    & Define.Prop<'project', ProjectRecord, true>
    /** Every chat of the workspace the page read: this project's, other projects' and those in none. */
    & Define.Prop<'chats', readonly ProjectChatRow[], true>
    & Define.Prop<'projects', readonly { readonly id: string; readonly name: string }[], true>
    & Define.Prop<'lookup', AgentLookup, true>
    /** The viewer's name, for the circle every row starts its participants with. */
    & Define.Prop<'you', string, true>
    /** A row's age from its last activity. */
    & Define.Prop<'age', (at: number) => string, true>
    & Define.Prop<'busy', boolean>
    & Define.Prop<'error', string>
    /** "Move" in the dialog: these chats into this project (`Chat.setProject`); resolves when done, so the dialog closes. */
    & Define.Prop<'onMove', (chatIds: readonly string[]) => Promise<void>, true>;

const PILLS: Readonly<Record<Exclude<ChatGroup, 'archived'>, { readonly tone: 'needs-you' | 'working' | 'muted'; readonly label: string; readonly hollow: boolean }>> = {
    'needs-you': { tone: 'needs-you', label: 'NEEDS YOU', hollow: false },
    working: { tone: 'working', label: 'WORKING', hollow: false },
    quiet: { tone: 'muted', label: 'IDLE', hollow: true }
};

const chipHref = (projectId: string, w: WorkChip): string | null =>
    w.kind === 'task' ? `/tasks/${w.id}` : w.kind === 'pull' ? `/projects/${projectId}/work/pr:${w.number}` : null;

const chipLabel = (w: WorkChip): string => (w.kind === 'task' ? w.id : w.kind === 'pull' ? `#${w.number}` : `${w.count} tasks`);

export const ChatsView = component<ChatsViewProps>(({ props }) => {
    const st = signal({ q: '', open: { archived: false } as Record<string, boolean>, moving: false, pick: [] as string[] });
    const collapsed = (g: ChatGroup): boolean => (g === 'archived' ? !st.open[g] : st.open[g] === false);
    const toggle = (g: ChatGroup): void => {
        st.open = { ...st.open, [g]: collapsed(g) };
    };
    const openMove = (): void => {
        st.pick = unassignedChats(props.chats, props.projects, props.project.id).filter((u) => u.suggested).map((u) => u.chat.id);
        st.moving = true;
    };
    const move = async (): Promise<void> => {
        if (!st.pick.length) return;
        try {
            await props.onMove([...st.pick]);
            st.moving = false;
        } catch {
            // The page shows the error; the dialog stays open so the move can be retried.
        }
    };

    const row = (c: ProjectChatRow) => {
        const g = chatGroupOf(c);
        const pill = g === 'archived' ? null : PILLS[g];
        return (
            <li data-project-chat-row={c.id} data-group={g}>
                <span data-project-chat-state>
                    {pill ? <StatusPill status={g} tone={pill.tone} label={pill.label} hollow={pill.hollow} /> : <StatusPill status="archived" tone="dim" label="ARCHIVED" hollow />}
                </span>
                <span data-project-chat-main>
                    <Link to={`/chats/${c.id}`}>
                        <span data-project-chat-title>{c.title}</span>
                        <span data-project-chat-last>{c.speaker ? <b>{c.speaker}: </b> : null}{c.lastLine}</span>
                    </Link>
                </span>
                <span data-project-chat-who aria-label={`You, ${c.agentIds.map((id) => props.lookup(id).name).join(', ')}`}>
                    <AgentTile name={props.you} person size={22} />
                    {c.agentIds.slice(0, 3).map((id) => {
                        const a = props.lookup(id);
                        return <AgentTile name={a.name} hue={a.hue} size={22} />;
                    })}
                    {c.agentIds.length > 3 ? <span data-member-more>+{c.agentIds.length - 3}</span> : null}
                </span>
                <span data-project-chat-work>
                    {c.work.length ? c.work.map((w) => {
                        const href = chipHref(props.project.id, w);
                        const icon = w.kind === 'pull' ? 'branch' : 'check';
                        return href
                            ? <span data-work-chip={w.kind}><Link to={href}><Icon name={icon} size={12} />{chipLabel(w)}</Link></span>
                            : <span data-work-chip={w.kind}><Icon name={icon} size={12} />{chipLabel(w)}</span>;
                    }) : <span data-project-chat-none>—</span>}
                </span>
                <span data-project-chat-age data-fresh={g === 'needs-you' ? '' : undefined}>{props.age(c.updatedAt)}</span>
            </li>
        );
    };

    return () => {
        const p = props.project;
        const groups = groupChats(props.chats, p.id, st.q);
        const all = groupChats(props.chats, p.id);
        const openCount = all['needs-you'].length + all.working.length + all.quiet.length;
        const outside = unassignedChats(props.chats, props.projects, p.id);
        const suggested = outside.filter((u) => u.suggested);
        const d = chatDefaults(p, (id) => props.lookup(id).name, (id) => featureViewsOf(id)?.label);
        const searching = st.q.trim() !== '';
        return (
            <div data-project-chats={p.id}>
                <header data-project-chats-head>
                    <span data-project-chats-title aria-hidden="true">Chats</span>
                    <span data-project-chats-counts>{`${openCount} open · ${all.archived.length} archived`}</span>
                    <span data-project-chats-actions>
                        <SearchField model={() => st.q} label={`Search chats in ${p.name}`} placeholder={`Search chats in ${p.name}`} />
                        <Button intent="primary" icon="chats" href="/chats/new">New chat</Button>
                    </span>
                </header>

                <div data-project-chats-defaults>
                    <Icon name="folder" size={14} />
                    <span>
                        {'New chats here start '}
                        {d.folder ? <>in <code>{d.folder}</code></> : 'with no folder, on the platform,'}
                        {` ${defaultsTail(d)}`}
                    </span>
                    <span data-project-chats-change-defaults><Link to={settingsHref(p.id, 'general')}>Change defaults</Link></span>
                </div>

                {props.error ? <ErrorNote data-project-chats-error="">{props.error}</ErrorNote> : null}

                {CHAT_GROUPS.map((g) => {
                    const rows = groups[g];
                    if (g !== 'archived' && !rows.length && (searching || !all[g].length)) return null;
                    if (g === 'archived' && !all.archived.length) return null;
                    const shut = collapsed(g) && !(searching && g === 'archived' && rows.length > 0);
                    return (
                        <section data-project-chat-group={g} aria-label={GROUP_LABELS[g]}>
                            <button type="button" data-project-chat-group-head aria-expanded={shut ? 'false' : 'true'} onClick={() => toggle(g)}>
                                <span data-group-dot data-group={g} aria-hidden="true" />
                                <span data-group-label>{GROUP_LABELS[g]}</span>
                                <span data-group-count>{rows.length}</span>
                                <Icon name={shut ? 'chevron-right' : 'chevron-down'} size={14} />
                            </button>
                            {shut ? null : rows.length ? (
                                <div data-project-chat-table>
                                    <div data-project-chat-cols aria-hidden="true"><span>State</span><span>Chat</span><span>Who</span><span>Linked work</span><span /></div>
                                    <ul>{rows.map(row)}</ul>
                                </div>
                            ) : <p data-panel-note="">Nothing matches.</p>}
                        </section>
                    );
                })}

                {searching && CHAT_GROUPS.every((g) => !groups[g].length) ? <p data-panel-note="" data-project-chats-empty="">{`No chat in ${p.name} matches “${st.q.trim()}”.`}</p> : null}
                {!searching && openCount === 0 && !all.archived.length ? <p data-panel-note="" data-project-chats-empty="">No chats in this project yet.</p> : null}

                {outside.length ? (
                    <div data-project-chats-unassigned>
                        <Icon name="chats" size={14} />
                        <span>
                            <b>{`${outside.length} ${outside.length === 1 ? 'chat isn’t' : 'chats aren’t'} in any project`}</b>
                            {suggested.length ? <span data-unassigned-hint>{`${listOf(suggested.map((u) => `“${u.chat.title}”`))} ${suggested.length === 1 ? 'mentions' : suggested.length === 2 ? 'both mention' : 'mention'} ${p.name}`}</span> : null}
                        </span>
                        <Button onClick={openMove}>Review and move</Button>
                    </div>
                ) : null}

                <p data-project-chats-release-note><Icon name="shield" size={13} /> Moving a chat into or out of a project runs each feature’s release step first, so Git can park the chat’s worktree before the folder changes.</p>

                {st.moving ? (
                    <FormDialog
                        model={() => st.moving}
                        title={`Move chats into ${p.name}`}
                        description="Chats outside every project. The ones that mention this project are ticked."
                        submitLabel={st.pick.length ? `Move ${st.pick.length}` : 'Move'}
                        busy={props.busy}
                        onSubmit={() => { void move(); }}
                        onCancel={() => { st.moving = false; }}
                    >
                        <fieldset data-project-chats-move>
                            <legend>Chats in no project</legend>
                            {outside.map((u) => (
                                <Checkbox.Root model={() => st.pick} name="move" value={u.chat.id} data-move-chat={u.chat.id}>
                                    {u.chat.title}
                                    {u.suggested ? <span data-move-suggested>{` · suggested: ${p.name}`}</span> : null}
                                </Checkbox.Root>
                            ))}
                        </fieldset>
                    </FormDialog>
                ) : null}
            </div>
        );
    };
}, { name: 'ProjectChatsView' });
