/**
 * The Plan list's 470px detail panel (#754; board `Plan`): the item's state and title; assigned, claimed, runs as,
 * after, unblocks and touches (with the overlap warning); refs, a file ref opening a hover card with its pinned
 * lines; the done-when checklist; activity; and the comment box, which names the refs it finds as you type.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { formatRef, parseRefs, planClaimLive, type PlanItem, type Ref } from '@agentic/core';
import { Icon, Tag, type Tone } from '@agentic/ui';
import { formatAge } from '../../../../../mock/workspace';
import { actorName } from '../shared/data';
import { ActorTile, useFollow } from '../shared/parts';
import { REF_KIND_HINT, leaseMinutesLeft, pinLine, queuePlace, refIcon, refLabel, shortPath, touchOverlaps, unblocksOf, type PlanDoc } from '../shared/model';

export type ItemDetailProps =
    & Define.Prop<'projectId', string, true>
    & Define.Prop<'doc', PlanDoc, true>
    & Define.Prop<'item', PlanItem, true>
    & Define.Prop<'items', readonly PlanItem[], true>
    & Define.Prop<'now', number, true>
    /** Open another item (a `#n` chip). */
    & Define.Prop<'onPick', (n: number) => void, true>
    & Define.Prop<'onClose', () => void, true>;

export const STATE_TAGS: Readonly<Record<PlanItem['state'], { readonly label: string; readonly tone: Tone }>> = {
    ready: { label: 'READY', tone: 'muted' },
    claimed: { label: 'CLAIMED', tone: 'working' },
    'needs-you': { label: 'NEEDS YOU', tone: 'needs-you' },
    blocked: { label: 'BLOCKED', tone: 'dim' },
    done: { label: 'DONE', tone: 'muted' },
    stuck: { label: 'STUCK', tone: 'failed' }
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
    const st = signal({ pin: '' as string, draft: '' });
    const follow = useFollow();
    const NavChip = (href: string, kind: string, body: JSXElement) => <a href={href} onClick={follow(href)} data-plan-chip={kind}>{body}</a>;
    const togglePin = (key: string): void => { st.pin = st.pin === key ? '' : key; };

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
                const pin = props.doc.pins?.[key];
                const open = st.pin === key;
                const run = props.doc.runs?.[props.item.id];
                return (
                    <span
                        data-plan-ref-file=""
                        onMouseenter={() => { st.pin = key; }}
                        onMouseleave={() => { if (st.pin === key) st.pin = ''; }}
                        onKeydown={(e: KeyboardEvent) => { if (e.key === 'Escape' && open) { st.pin = ''; e.stopPropagation(); } }}
                    >
                        <button type="button" data-plan-chip="file" aria-expanded={open ? 'true' : 'false'} title={ref.path} onClick={() => togglePin(key)}>{body}</button>
                        {open
                            ? (
                                <span data-plan-pin="" role="group" aria-label={`${ref.path} lines ${ref.from} to ${ref.to}`}>
                                    <span data-plan-pin-head="">
                                        <Icon name="file" size={12} />
                                        <span data-plan-pin-path="">{ref.path}</span>
                                        <span data-plan-pin-at="">{pinLine(ref, pin)}</span>
                                    </span>
                                    {pin
                                        ? (
                                            <span data-plan-pin-code="">
                                                {pin.lines.map((line, i) => (
                                                    <span data-plan-pin-line={ref.from + i}><span data-plan-pin-n="">{ref.from + i}</span><code>{line}</code></span>
                                                ))}
                                            </span>
                                        )
                                        : <span data-plan-pin-empty="">The pinned lines load with the file.</span>}
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
                            ? <>{ActorTile(item.assignee, 20)}<strong>{actorName(item.assignee)}</strong>
                                <span data-dim="">{[item.assignedBy ? `by ${actorName(item.assignedBy)}` : '', place ?? ''].filter(Boolean).join(' · ')}</span></>
                            : <span data-dim="">Not assigned</span>}
                    </dd>
                    <dt>Claimed</dt>
                    <dd data-fact="claimed">
                        {item.claim && item.state === 'done'
                            ? item.claim.taskId
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
                                        {`#${o.item.id}${o.item.assignee ? ` (${actorName(o.item.assignee)})` : ''} touches ${shortPath(o.path)} too.`}
                                    </p>
                                ))}
                            </dd>
                        </>
                        : null}
                </dl>

                {item.options?.length
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
                                {item.doneWhen.map((d) => (
                                    <li data-checked={d.checked ? 'true' : 'false'}>
                                        <input type="checkbox" checked={d.checked} disabled aria-label={d.text} />
                                        <span>{d.text}</span>
                                    </li>
                                ))}
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
                                        {ActorTile(a.actor, 18)}
                                        <span><strong>{actorName(a.actor)}</strong> {a.text}</span>
                                        <span data-plan-age="">{formatAge(a.at, props.now)}</span>
                                    </li>
                                ))}
                            </ul>
                        )
                        : <p data-dim="">Nothing yet.</p>}
                </section>

                <form data-plan-comment="" onSubmit={(e: Event) => e.preventDefault()}>
                    <input
                        type="text"
                        aria-label={`Comment on #${item.id}`}
                        placeholder="Comment. # item, @ agent, / file, pr: PR"
                        value={st.draft}
                        onInput={(e: Event) => { st.draft = (e.target as HTMLInputElement).value; }}
                    />
                    <button type="submit" aria-label="Send comment" disabled title="Comments arrive with the Plan store"><Icon name="send" size={14} /></button>
                    {hints.length
                        ? (
                            <ul data-plan-comment-refs="" aria-label="Refs in your comment">
                                {hints.map((h) => <li data-ref-kind={h.ref.kind}><code>{h.text}</code> {REF_KIND_HINT[h.ref.kind]}</li>)}
                            </ul>
                        )
                        : null}
                </form>
            </aside>
        );
    };
}, { name: 'ItemDetail' });
