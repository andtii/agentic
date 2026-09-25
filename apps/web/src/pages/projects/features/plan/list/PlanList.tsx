/**
 * The Plan list (#754, PRJ-13; board `Plan`, docs/design/projects/HANDOFF.md → "Plan"): the header, the crew strip,
 * search with All / Mine / Open, the phases (collapsible, a mini progress each; a finished phase starts closed) with
 * their item rows, and the item detail panel. `?plan=` picks the plan, `?item=` the item the panel opens on.
 * Live (#926) it reads the project's Plan actor and writes to it: Add item, New plan, done-when ticks and comments;
 * a refusal shows as the note above the list.
 */
import { component, signal } from 'sigx';
import { useRoute } from '@sigx/router';
import { planItems, type PlanItem, type PlanPhase } from '@agentic/core';
import { Button, EmptyState, Icon, ItemGlyph, SearchField, Segmented } from '@agentic/ui';
import { formatAge } from '../../../../../mock/workspace';
import type { ProjectPageProps } from '../../../layout/types';
import { actorLook, actorName, planNow, planViewer, usePlanStore } from '../shared/data';
import { ActorTile, Bar, PlanHeader } from '../shared/parts';
import {
    PLAN_FILTERS, crewCounts, crewOf, defaultItem, filterPhases, itemMeta, lastActivityAt, ownerStatus, phaseProgress, planOf,
    type PlanDoc, type PlanFilter
} from '../shared/model';
import { ItemDetail } from './ItemDetail';

const CrewStrip = (doc: PlanDoc, members: ProjectPageProps['project']['members']) => (
    <section data-plan-crew="" aria-label="Crew">
        <span data-plan-crew-label="">Crew</span>
        <ul>
            {crewOf(doc.plan, members, planViewer()).map((e) => {
                const look = actorLook(e.actor);
                const counts = crewCounts(e);
                return (
                    <li data-plan-crew-member={look.name}>
                        {ActorTile(e.actor, 20)}
                        <span data-plan-crew-name="">{look.name}</span>
                        {e.manager ? <span data-plan-crew-role="">project manager</span> : null}
                        {counts.length
                            ? <span data-plan-crew-counts="">{counts.map((c, i) => <>{i ? <span data-sep=""> · </span> : null}<span data-plan-tone={c.tone}>{c.text}</span></>)}</span>
                            : e.manager ? null : <span data-plan-crew-counts=""><span data-plan-tone="dim">idle</span></span>}
                    </li>
                );
            })}
        </ul>
    </section>
);

export const PlanList = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    const store = usePlanStore(() => props.project.id);
    const writes = store.writes;
    // `picked`: undefined → `?item=` or the default item; null → the panel is closed.
    const st = signal({ q: '', filter: 'all' as string, open: {} as Record<number, boolean>, picked: undefined as number | null | undefined });

    const phaseOpen = (phase: PlanPhase, narrowed: boolean): boolean =>
        narrowed || (st.open[phase.n] ?? phaseProgress(phase).done < phase.items.length);

    const Row = (item: PlanItem, all: readonly PlanItem[], doc: PlanDoc, now: number, selected: boolean) => {
        const meta = itemMeta(item, all, actorName, doc.runs?.[item.id]);
        const owner = ownerStatus(item);
        const at = lastActivityAt(item);
        return (
            <li data-plan-item={item.id} data-state={item.state}>
                <button type="button" data-plan-row="" aria-pressed={selected ? 'true' : 'false'} onClick={() => { st.picked = item.id; }}>
                    <span data-plan-item-id="">{`#${item.id}`}</span>
                    <ItemGlyph state={item.state} />
                    <span data-plan-item-main="">
                        <span data-plan-item-title="">{item.title}</span>
                        {meta.length
                            ? <span data-plan-item-meta="">{meta.map((m, i) => <>{i ? <span data-sep=""> · </span> : null}<span data-plan-tone={m.tone}>{m.text}</span></>)}</span>
                            : null}
                    </span>
                    <span data-plan-item-owner="" data-assigned={item.assignee ? 'true' : 'false'}>
                        {item.assignee ? ActorTile(item.assignee, 22) : <span data-plan-nobody="" aria-hidden="true" />}
                        <span data-plan-owner-text="">
                            {item.assignee ? <span data-plan-owner-name="">{actorName(item.assignee)}</span> : null}
                            <span data-plan-owner-status="" data-plan-tone={owner.tone}>{owner.text}</span>
                        </span>
                    </span>
                    <span data-plan-item-refs="" aria-label={`${item.refs.length} refs`}><Icon name="link" size={12} />{String(item.refs.length)}</span>
                    <span data-plan-item-age="">{at === undefined ? '—' : formatAge(at, now)}</span>
                </button>
            </li>
        );
    };

    const Note = () => (store.note() ? <p data-plan-note="" role="alert">{store.note()}</p> : null);
    const newPlan = (): void => { if (writes) void writes.newPlan('Untitled plan 1'); };

    return () => {
        const docs = store.docs();
        const doc = planOf(docs, route.query.plan);
        if (!doc) {
            if (store.loading) return <section aria-label="Plan" data-plan-list="" data-loading=""><p data-plan-none="" role="status">Loading the plan…</p></section>;
            return (
                <section aria-label="Plan" data-plan-list="">
                    {Note()}
                    <EmptyState
                        variant="generic"
                        title="No plan yet"
                        caption="The project manager drafts one from a chat, or you start one here."
                        {...(writes ? { slots: { actions: () => <Button intent="primary" icon="plus" onClick={newPlan}>New plan</Button> } } : {})}
                    />
                </section>
            );
        }
        const now = planNow();
        const all = planItems(doc.plan);
        const filter = st.filter as PlanFilter;
        const narrowed = st.q.trim() !== '' || filter !== 'all';
        const phases = filterPhases(doc.plan, st.q, filter, planViewer());
        const queried = Number(route.query.item);
        const pickedId = st.picked === undefined ? (all.some((i) => i.id === queried) ? queried : defaultItem(doc.plan)?.id) : st.picked;
        const picked = pickedId === null || pickedId === undefined ? undefined : all.find((i) => i.id === pickedId);
        return (
            <section aria-label="Plan" data-plan-list="" data-detail={picked ? 'open' : 'closed'}>
                <PlanHeader
                    projectId={props.project.id}
                    doc={doc}
                    view="list"
                    several={docs.length > 1}
                    {...(writes ? { onAdd: async (title: string) => (await writes.addItem(doc.plan, title)) !== undefined } : {})}
                />
                {Note()}
                {CrewStrip(doc, props.project.members)}
                <div data-plan-body="">
                    <div data-plan-items="">
                        <div data-plan-toolbar="">
                            <SearchField model={() => st.q} label="Search items, refs, paths" placeholder="Search items, refs, paths" />
                            <Segmented model={() => st.filter} label="Show" options={PLAN_FILTERS} />
                        </div>
                        {phases.length
                            ? phases.map(({ phase, items }) => {
                                const progress = phaseProgress(phase);
                                const open = phaseOpen(phase, narrowed);
                                return (
                                    <section data-plan-phase={phase.n} aria-label={phase.title}>
                                        <button
                                            type="button"
                                            data-plan-phase-head=""
                                            aria-expanded={open ? 'true' : 'false'}
                                            disabled={narrowed}
                                            onClick={() => { st.open = { ...st.open, [phase.n]: !open }; }}
                                        >
                                            <span data-plan-phase-n="">{String(phase.n)}</span>
                                            <span data-plan-phase-title="">{phase.title}</span>
                                            <span data-plan-phase-count="">{`${progress.done}/${progress.total}`}</span>
                                            {Bar(progress, 'phase')}
                                            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                                        </button>
                                        {open ? <ul data-plan-rows="">{items.map((i) => Row(i, all, doc, now, i.id === picked?.id))}</ul> : null}
                                    </section>
                                );
                            })
                            : <p data-plan-none="">No items match.</p>}
                    </div>
                    {picked
                        ? <ItemDetail key={picked.id} projectId={props.project.id} doc={doc} item={picked} items={all} now={now} onPick={(n) => { st.picked = n; }} onClose={() => { st.picked = null; }}
                            {...(writes
                                ? {
                                    onTick: (index: number, checked: boolean) => void writes.tick(picked.id, index, checked),
                                    onComment: async (text: string) => (await writes.comment(picked.id, text)) !== undefined
                                }
                                : {})}
                        />
                        : null}
                </div>
            </section>
        );
    };
}, { name: 'PlanList' });
