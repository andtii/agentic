/**
 * The Plan list's 470px detail panel (#754; board `Plan`): the item's state and title; assigned, claimed, runs as,
 * after, unblocks and touches (with the overlap warning); refs, a file ref opening a hover card with its pinned
 * lines; the done-when checklist; activity; and the comment box, which names the refs it finds as you type. A needs-you
 * item opens on its question and the answer box (`NeedsYouCard`, #1044). The comment box is the chat's composer: `@`
 * picks a project agent and `#` an item, and the agents a comment names are woken with it.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { Checkbox } from '@sigx/zero';
import { formatRef, parseRefs, planClaimLive, type AgentId, type PlanActor, type PlanItem, type ProjectMembers, type Ref } from '@agentic/core';
import { Composer, Icon, Tag, type ComposerInsert, type Mention, type Tone } from '@agentic/ui';
import { formatAge } from '../../../../../mock/workspace';
import { mentionsIn, unknownAgent } from '../../../../chat/live';
import { chatRefSources } from '../../../../chat/project-context';
import { mockPlanIdentity, type PlanIdentity, type PlanWrites } from '../shared/data';
import { NeedsYouCard } from '../shared/NeedsYouCard';
import type { PinSource } from '../shared/pins';
import { ActorTile, useFollow } from '../shared/parts';
import { REF_KIND_HINT, leaseMinutesLeft, pinLine, queuePlace, refIcon, refLabel, shortPath, touchOverlaps, unblocksOf, type PlanDoc, type PlanFilePin } from '../shared/model';

type FileRef = Extract<Ref, { kind: 'file' }>;

export type ItemDetailProps =
    & Define.Prop<'projectId', string, true>
    & Define.Prop<'doc', PlanDoc, true>
    & Define.Prop<'item', PlanItem, true>
    & Define.Prop<'items', readonly PlanItem[], true>
    & Define.Prop<'now', number, true>
    /** Open another item (a `#n` chip). */
    & Define.Prop<'onPick', (n: number) => void, true>
    & Define.Prop<'onClose', () => void, true>
    /** Tick a done-when line (live, #926). Absent, the checklist is read-only. */
    & Define.Prop<'onTick', (index: number, checked: boolean) => void>
    /** Send a comment and the agents it names (live, #926, #1044); resolves whether it went. Absent, the box is disabled. */
    & Define.Prop<'onComment', (text: string, mentions: readonly AgentId[]) => Promise<boolean>>
    /** Answer a needs-you item (live, #1044); resolves whether it went. Absent, the question is read-only. */
    & Define.Prop<'onAnswer', (text: string) => Promise<boolean>>
    /** Mark a needs-you item done instead (live, #1044). */
    & Define.Prop<'onDone', () => Promise<boolean>>
    /** The project's agents, whom `@` picks (#1044); none when absent. */
    & Define.Prop<'members', ProjectMembers>
    /** Who "You" is and how actors are named (#939); the mock workspace's when absent. */
    & Define.Prop<'identity', PlanIdentity>
    /** File refs' pinned lines read live (#939); absent, the doc's `pins` answer. */
    & Define.Prop<'pins', PinSource>;

/** The panel's writes for item `itemId` (#926, #1044); none (read-only) without `writes`. */
export function detailWrites(writes: PlanWrites | undefined, itemId: number): Pick<ItemDetailProps, 'onTick' | 'onComment' | 'onAnswer' | 'onDone'> {
    if (!writes) return {};
    return {
        onTick: (index: number, checked: boolean) => void writes.tick(itemId, index, checked),
        onComment: async (text: string, mentions: readonly AgentId[]) => (await writes.comment(itemId, text, mentions)) !== undefined,
        onAnswer: async (text: string) => (await writes.answer(itemId, text)) !== undefined,
        onDone: async () => (await writes.done(itemId)) !== undefined
    };
}

export const STATE_TAGS: Readonly<Record<PlanItem['state'], { readonly label: string; readonly tone: Tone }>> = {
    ready: { label: 'READY', tone: 'muted' },
    claimed: { label: 'CLAIMED', tone: 'working' },
    'needs-you': { label: 'NEEDS YOU', tone: 'needs-you' },
    blocked: { label: 'BLOCKED', tone: 'dim' },
    done: { label: 'DONE', tone: 'muted' },
    stuck: { label: 'STUCK', tone: 'failed' },
    dropped: { label: 'DROPPED', tone: 'dim' }
};

const ItemChip = (n: number, items: readonly PlanItem[], onPick: (n: number) => void) => {
    const it = items.find((i) => i.id === n);
    return (
        <button type="button" data-plan-chip="item" data-state={it?.state} onClick={() => onPick(n)}>
            <Icon name="menu" size={12} />
            {`#${n}`}{it?.state === 'done' ? <small> done</small> : null}
        </button>
    );
};

export const ItemDetail = component<ItemDetailProps>(({ props }) => {
    const st = signal({ pin: '' as string, draft: '', sending: false, insert: null as ComposerInsert | null });
    let inserts = 0;
    const agentIds = (): readonly string[] => props.members?.agentIds ?? [];
    const agentName = (id: string): string => (props.identity ?? mockPlanIdentity).name({ kind: 'agent', agentId: id as AgentId });
    /** `@` offers the project's agents by name — what the picker inserts and `mentionsIn` reads back. */
    const mentions = (): Mention[] => agentIds().map((id) => ({ id: agentName(id), label: agentName(id), ...(props.members?.coordinator === id ? { description: 'project manager' } : {}) }));
    const send = async (text: string): Promise<void> => {
        if (!text || st.sending || !props.onComment) return;
        const named = mentionsIn(text, agentIds().map((agentId) => ({ agentId, status: 'idle', history: { access: 'all' } })), (id) => ({ ...unknownAgent(id), name: agentName(id) }));
        st.sending = true;
        st.draft = '';
        let sent = false;
        try {
            sent = await props.onComment(text, named);
        } catch {
            sent = false;
        } finally {
            st.sending = false;
        }
        // The composer cleared its draft on send: a refused comment goes back into it.
        if (!sent) st.insert = { id: `retry-${++inserts}`, text };
    };
    const follow = useFollow();
    const NavChip = (href: string, kind: string, body: JSXElement) => <a href={href} onClick={follow(href)} data-plan-chip={kind}>{body}</a>;
    const name = (a: PlanActor): string => (props.identity ?? mockPlanIdentity).name(a);
    const tile = (a: PlanActor, size: 18 | 20) => ActorTile(a, size, (props.identity ?? mockPlanIdentity).look);
    const openPin = (key: string, ref: FileRef): void => {
        st.pin = key;
        props.pins?.open(ref, props.doc.runs?.[props.item.id]);
    };
    const togglePin = (key: string, ref: FileRef): void => {
        if (st.pin === key) st.pin = '';
        else openPin(key, ref);
    };
    /** The card's code, or what stands in for it. */
    const PinBody = (ref: FileRef, pin: PlanFilePin | undefined): JSXElement => {
        const lines = (ls: readonly string[]) => (
            <span data-plan-pin-code="">
                {ls.map((line, i) => (
                    <span data-plan-pin-line={ref.from + i}><span data-plan-pin-n="">{ref.from + i}</span><code>{line}</code></span>
                ))}
            </span>
        );
        if (!props.pins) return pin ? lines(pin.lines) : <span data-plan-pin-empty="">The pinned lines load with the file.</span>;
        const view = props.pins.view(ref, props.doc.runs?.[props.item.id]);
        if (!view) return <span data-plan-pin-empty="">Not pinned to a commit, so there are no fixed lines to show.</span>;
        switch (view.status) {
            case 'done': return lines(view.lines);
            case 'loading': return <span data-plan-pin-empty="" data-plan-pin-status="loading" role="status">Reading the pinned lines…</span>;
            case 'offline': return <span data-plan-pin-empty="" data-plan-pin-status="offline" role="status">{`${view.machine} is offline, so the pinned lines cannot be read.`}</span>;
            case 'nowhere': return <span data-plan-pin-empty="" data-plan-pin-status="nowhere" role="status">No machine holds this project's folder, so the pinned lines cannot be read.</span>;
            default: return <span data-plan-pin-empty="" data-plan-pin-status="error" role="status">{`Could not read the pinned lines: ${view.message}`}</span>;
        }
    };

    const RefChip = (ref: Ref) => {
        const key = formatRef(ref);
        const body = <><Icon name={refIcon(ref)} size={12} /><span>{refLabel(ref)}</span></>;
        switch (ref.kind) {
            case 'item':
                return ItemChip(ref.n, props.items, props.onPick);
            case 'pr':
                return NavChip(`/projects/${props.projectId}/work/pr:${ref.n}`, 'pr', body);
            case 'url':
                return <a href={ref.url} target="_blank" rel="noopener noreferrer" data-plan-chip="url">{body}</a>;
            case 'file': {
                const live = props.pins?.view(ref, props.doc.runs?.[props.item.id]);
                const pin: PlanFilePin | undefined = props.pins ? (live?.status === 'done' ? { lines: live.lines, ...(live.branch ? { branch: live.branch } : {}) } : undefined) : props.doc.pins?.[key];
                const open = st.pin === key;
                const run = props.doc.runs?.[props.item.id];
                return (
                    <span
                        data-plan-ref-file=""
                        onMouseenter={() => openPin(key, ref)}
                        onMouseleave={() => { if (st.pin === key) st.pin = ''; }}
                        onKeydown={(e: KeyboardEvent) => { if (e.key === 'Escape' && open) { st.pin = ''; e.stopPropagation(); } }}
                    >
                        <button type="button" data-plan-chip="file" aria-expanded={open ? 'true' : 'false'} title={ref.path} onClick={() => togglePin(key, ref)}>{body}</button>
                        {open
                            ? (
                                <span data-plan-pin="" role="group" aria-label={`${ref.path} lines ${ref.from} to ${ref.to}`}>
                                    <span data-plan-pin-head="">
                                        <Icon name="file" size={12} />
                                        <span data-plan-pin-path="">{ref.path}</span>
                                        <span data-plan-pin-at="">{pinLine(ref, pin)}</span>
                                    </span>
                                    {PinBody(ref, pin)}
                                    <span data-plan-pin-foot="">
                                        <span>{ref.sha ? 'Pinned to a commit, so the lines stay right after edits' : 'Not pinned yet: the lines follow the file'}</span>
                                        {run?.sessionId ? <Link to={`/sessions/${run.sessionId}/files`}>Open file</Link> : null}
                                    </span>
                                </span>
                            )
                            : null}
                    </span>
                );
            }
            default:
                return <span data-plan-chip={ref.kind} title={key}>{body}</span>;
        }
    };

    return () => {
        const { item, items, doc } = props;
        const tag = STATE_TAGS[item.state];
        const run = doc.runs?.[item.id];
        const unblocks = unblocksOf(item, items);
        const overlaps = touchOverlaps(item, items);
        const place = queuePlace(item, items);
        const hints = parseRefs(st.draft);
        const claimLive = planClaimLive(item.claim, props.now);
        return (
            <aside data-plan-detail={item.id} aria-label={`#${item.id} ${item.title}`}>
                <header data-plan-detail-head="">
                    <span data-plan-detail-id="">{`#${item.id}`}</span>
                    <Tag tone={tag.tone}>{tag.label}</Tag>
                    <button type="button" data-plan-detail-close="" aria-label="Close item" onClick={() => props.onClose()}><Icon name="close" size={14} /></button>
                </header>
                <h3 data-plan-detail-title="">{item.title}</h3>

                <dl data-plan-facts="">
                    <dt>Assigned to</dt>
                    <dd data-fact="assigned">
                        {item.assignee
                            ? <>{tile(item.assignee, 20)}<strong>{name(item.assignee)}</strong>
                                <span data-dim="">{[item.assignedBy ? `by ${name(item.assignedBy)}` : '', place ?? ''].filter(Boolean).join(' · ')}</span></>
                            : <span data-dim="">Not assigned</span>}
                    </dd>
                    <dt>Claimed</dt>
                    <dd data-fact="claimed">
                        {item.state === 'done'
                            ? item.claim?.taskId
                                ? <><span data-dim="">{'finished by '}</span>{NavChip(`/tasks/${item.claim.taskId}`, 'task', <><Icon name="check" size={12} />{item.claim.taskId}</>)}</>
                                : <span data-dim="">Done</span>
                            : item.claim && claimLive
                            ? <><span data-plan-tone="working">working now</span><span data-dim="">{`· lease ${leaseMinutesLeft(item.claim.leaseUntil, props.now)} min left, renews while it works`}</span></>
                            : item.claim
                                ? <span data-plan-tone="needs-you">lease ran out</span>
                                : <span data-dim="">Not claimed</span>}
                    </dd>
                    {run
                        ? <>
                            <dt>Runs as</dt>
                            <dd data-fact="runs">
                                {NavChip(`/tasks/${run.taskId}`, 'task', <><Icon name="check" size={12} />{run.taskRef}</>)}
                                <span data-dim="" data-mono="">{[run.machine, run.branch ? `branch ${run.branch}` : ''].filter(Boolean).join(' · ')}</span>
                            </dd>
                        </>
                        : null}
                    {item.state === 'dropped' && item.dropped
                        ? <>
                            <dt>Dropped</dt>
                            <dd data-fact="dropped">
                                <span>{`by ${name(item.dropped.by)}`}</span>
                                {item.dropped.supersededBy !== undefined ? <> <span data-dim="">superseded by</span> {ItemChip(item.dropped.supersededBy, items, props.onPick)}</> : null}
                                {item.dropped.note ? <p data-plan-dropped-note="">{item.dropped.note}</p> : null}
                            </dd>
                        </>
                        : null}
                    {item.after.length ? <><dt>After</dt><dd data-fact="after">{item.after.map((n) => ItemChip(n, items, props.onPick))}</dd></> : null}
                    {unblocks.length ? <><dt>Unblocks</dt><dd data-fact="unblocks">{unblocks.map((u) => ItemChip(u.id, items, props.onPick))}</dd></> : null}
                    {item.touches.length
                        ? <>
                            <dt>Touches</dt>
                            <dd data-fact="touches">
                                {item.touches.map((p) => <span data-plan-chip="path" title={p}><Icon name="file" size={12} />{shortPath(p)}</span>)}
                                {overlaps.map((o) => (
                                    <p data-plan-overlap={o.item.id} role="note">
                                        <Icon name="warning" size={13} />
                                        {`#${o.item.id}${o.item.assignee ? ` (${name(o.item.assignee)})` : ''} touches ${shortPath(o.path)} too.`}
                                    </p>
                                ))}
                            </dd>
                        </>
                        : null}
                </dl>

                {item.state === 'needs-you'
                    ? <NeedsYouCard item={item} now={props.now} name={name} {...(props.onAnswer ? { onAnswer: props.onAnswer } : {})} {...(props.onDone ? { onDone: props.onDone } : {})} />
                    : null}

                {item.options?.length && item.state !== 'needs-you'
                    ? (
                        <section data-plan-detail-section="options" aria-label="Options">
                            <h4>Options</h4>
                            <ul data-plan-options="">{item.options.map((o) => <li>{o.label}{o.detail ? <small>{o.detail}</small> : null}</li>)}</ul>
                        </section>
                    )
                    : null}

                <section data-plan-detail-section="refs" aria-label="Refs">
                    <h4>Refs</h4>
                    {item.refs.length ? <div data-plan-refs="">{item.refs.map(RefChip)}</div> : <p data-dim="">No refs yet.</p>}
                </section>

                {item.doneWhen.length
                    ? (
                        <section data-plan-detail-section="done-when" aria-label="Done when">
                            <h4>Done when</h4>
                            <ul data-plan-done-when="">
                                {item.doneWhen.map((d, index) => {
                                    // The item owns the tick: zero writes into this throwaway binding, `onTick` tells the page.
                                    const bind = signal({ checked: d.checked });
                                    return (
                                        <li data-checked={d.checked ? 'true' : 'false'}>
                                            <Checkbox.Root model={() => bind.checked} name={`done-when-${index}`} disabled={!props.onTick} onCheckedChange={(on: boolean) => props.onTick?.(index, on)}>
                                                {d.text}
                                            </Checkbox.Root>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    )
                    : null}

                <section data-plan-detail-section="activity" aria-label="Activity">
                    <h4>Activity</h4>
                    {item.activity.length
                        ? (
                            <ul data-plan-activity="">
                                {[...item.activity].sort((a, b) => b.at - a.at).map((a) => (
                                    <li>
                                        {tile(a.actor, 18)}
                                        <span><strong>{name(a.actor)}</strong> {a.text}</span>
                                        <span data-plan-age="">{formatAge(a.at, props.now)}</span>
                                    </li>
                                ))}
                            </ul>
                        )
                        : <p data-dim="">Nothing yet.</p>}
                </section>

                <div data-plan-comment="" onInput={(e: Event) => { if (e.target instanceof HTMLTextAreaElement) st.draft = e.target.value; }}>
                    <Composer
                        mentions={mentions()}
                        refs={chatRefSources(['#'], items, [])}
                        busy={st.sending}
                        disabled={!props.onComment}
                        placeholder={props.onComment ? 'Comment. @ an agent to wake it, # an item, pr: a PR' : 'Comments need the Plan store'}
                        minRows={1}
                        maxRows={4}
                        {...(st.insert ? { insert: st.insert } : {})}
                        onDraft={(draft: string) => { st.draft = draft; }}
                        onSend={(text: string) => { void send(text); }}
                    />
                    {hints.length
                        ? (
                            <ul data-plan-comment-refs="" aria-label="Refs in your comment">
                                {hints.map((h) => <li data-ref-kind={h.ref.kind}><code>{h.text}</code> {REF_KIND_HINT[h.ref.kind]}</li>)}
                            </ul>
                        )
                        : null}
                </div>
            </aside>
        );
    };
}, { name: 'ItemDetail' });
