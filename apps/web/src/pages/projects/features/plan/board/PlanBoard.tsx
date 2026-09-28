import { component, signal } from 'sigx';
import { useRoute } from '@sigx/router';
import { ErrorNote } from '@agentic/ui';
import { planItems, type AgentId, type Plan, type PlanActor, type PlanItem } from '@agentic/core';
import { useActorDefs, useViewer } from '../../../../../actors/defs';
import { dataMode } from '../../../../../data-mode';
import { USER, agentNamed } from '../../../../../mock/workspace';
import { useAgentDirectory } from '../../../../chat/directory';
import type { ProjectPageProps } from '../../../layout/types';
import { BoardView } from './BoardView';
import { boardFixture } from './fixture';
import { mockPlanIdentity, usePlanIdentity, usePlanStore, type PlanIdentity, type PlanWrites } from '../shared/data';
import { usePlanNav } from '../shared/parts';
import { useLivePins, type PinSource } from '../shared/pins';
import { planOf, type PlanDoc } from '../shared/model';
import { ItemDetail, detailWrites } from '../list/ItemDetail';
import { assignIndex, boardColumns, columnOf, moveItem, needsHandoff, type BoardSlot } from './model';

const ME = 'me';
const YOU: PlanActor = { kind: 'user', userId: ME };

/** The `?item=` the board opens on, when the plan has it (#1037). */
const queriedItem = (query: unknown, items: readonly PlanItem[]): number | null => {
    const n = Number(query);
    return items.some((i) => i.id === n) ? n : null;
};

/** The List's detail panel for the open card (#1037); ticks and comments go to `writes` when there are any. */
const Detail = (project: ProjectPageProps['project'], doc: PlanDoc, id: number | null, now: number, identity: PlanIdentity, pick: (n: number | null) => void, pins?: PinSource, writes?: PlanWrites) => {
    const all = planItems(doc.plan);
    const item = id === null ? undefined : all.find((i) => i.id === id);
    if (!item) return null;
    return (
        <ItemDetail key={item.id} projectId={project.id} doc={doc} item={item} items={all} now={now} identity={identity} members={project.members} {...(pins ? { pins } : {})} onPick={(n) => pick(n)} onClose={() => pick(null)}
            {...detailWrites(writes, item.id)}
        />
    );
};

/** On mock data: the board artboard's plan; drags change it for the page's lifetime. */
const MockPlanBoard = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    const now = Date.now();
    const plan = boardFixture(props.project.id, now);
    const st = signal({ items: (plan?.items ?? []) as readonly PlanItem[], open: queriedItem(route.query.item, plan?.items ?? []) });
    const doc = (): PlanDoc => {
        const p: Plan = { id: 'board', projectId: props.project.id as Plan['projectId'], title: plan?.title ?? 'Plan', phases: [{ n: 1, title: plan?.title ?? 'Plan', items: st.items }] };
        return { plan: p };
    };
    const pick = (n: number | null): void => { st.open = n; };
    const move = (id: number, slot: BoardSlot, note?: string): void => {
        st.items = moveItem(st.items, id, slot, { you: YOU, at: Date.now(), ...(note ? { note } : {}) });
    };
    return () => (
        <BoardView projectId={props.project.id} title={plan?.title ?? 'Plan'} items={st.items} members={props.project.members} lookup={agentNamed} you={USER.name} me={ME} now={now} onMove={move}
            {...(st.open === null ? {} : { openId: st.open })} onOpen={pick} detail={() => Detail(props.project, doc(), st.open, now, mockPlanIdentity, pick)} />
    );
}, { name: 'MockPlanBoard' });

/**
 * Live (#926): the project's plan (`?plan=`, else its first) from its Plan actor, the members as columns. A drop is
 * the actor's `assign` (into a queue at a position, or back to the open pool); dropping a card an agent is working
 * hands it off with the note. The board redraws from the actor's answer; a refusal shows as the note above it.
 */
const LivePlanBoard = component<ProjectPageProps>(({ props }) => {
    const route = useRoute();
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const store = usePlanStore(() => props.project.id);
    const identity = usePlanIdentity();
    const pins = useLivePins(() => props.project);
    // `open`: undefined → `?item=`, if the plan has it; null → no panel.
    const st = signal({ refused: '', open: undefined as number | null | undefined });
    const pick = (n: number | null): void => { st.open = n; };
    const nav = usePlanNav('board', () => props.project.id, store);
    const items = (): readonly PlanItem[] => {
        const doc = planOf(store.docs(), route.query.plan, route.query.item);
        return doc ? planItems(doc.plan) : [];
    };
    const move = (id: number, slot: BoardSlot, note?: string): void => {
        const all = items();
        const item = all.find((i) => i.id === id);
        const writes = store.writes;
        if (!item || !writes) return;
        st.refused = '';
        const me = viewer.userId;
        if (slot.column === 'you' && !me) {
            st.refused = `Could not move #${id}: sign in to take items yourself.`;
            return;
        }
        const to: PlanActor | null = slot.column === 'open' ? null : slot.column === 'you' ? { kind: 'user', userId: me! } : { kind: 'agent', agentId: slot.column.slice('agent:'.length) as AgentId };
        const now = Date.now();
        if (note?.trim() && needsHandoff(item, slot, now)) {
            void writes.handoff(id, to, note.trim());
            return;
        }
        if (columnOf(item, me ?? '') === slot.column && slot.column === 'open') return;
        void writes.assign(id, to, to === null ? undefined : assignIndex(item, slot, boardColumns(all, props.project.members, now, me ?? '')));
    };
    return () => {
        const doc = planOf(store.docs(), route.query.plan, route.query.item);
        const note = st.refused || store.note();
        const now = Date.now();
        const open = st.open === undefined ? queriedItem(route.query.item, items()) : st.open;
        return (
            <>
                {note ? <ErrorNote data-plan-note="">{note}</ErrorNote> : null}
                <BoardView
                    projectId={props.project.id}
                    title={doc?.plan.title ?? 'Plan'}
                    items={items()}
                    members={props.project.members}
                    lookup={directory.lookup}
                    you="You"
                    me={viewer.userId ?? ''}
                    now={now}
                    onMove={move}
                    {...(open === null ? {} : { openId: open })}
                    onOpen={pick}
                    detail={() => (doc ? Detail(props.project, doc, open, now, identity, pick, pins, store.writes) : null)}
                    plans={store.docs().map((d) => d.plan)}
                    {...(doc ? { planId: doc.plan.id } : {})}
                    onSelectPlan={nav.select}
                    {...(nav.create ? { onNewPlan: nav.create } : {})}
                />
            </>
        );
    };
}, { name: 'LivePlanBoard' });

/** The Plan board view (#755, PRJ-13): columns by agent, limits, drag to assign and reorder. */
export const PlanBoard = component<ProjectPageProps>(({ props }) => () => (
    dataMode() === 'live' ? <LivePlanBoard project={props.project} /> : <MockPlanBoard project={props.project} />
), { name: 'PlanBoard' });
