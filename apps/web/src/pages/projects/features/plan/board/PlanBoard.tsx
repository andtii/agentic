import { component, signal } from 'sigx';
import { useRoute } from '@sigx/router';
import { planItems, type AgentId, type PlanActor, type PlanItem } from '@agentic/core';
import { useActorDefs, useViewer } from '../../../../../actors/defs';
import { dataMode } from '../../../../../data-mode';
import { USER, agentNamed } from '../../../../../mock/workspace';
import { useAgentDirectory } from '../../../../chat/directory';
import type { ProjectPageProps } from '../../../layout/types';
import { BoardView } from './BoardView';
import { boardFixture } from './fixture';
import { usePlanStore } from '../shared/data';
import { planOf } from '../shared/model';
import { assignIndex, boardColumns, columnOf, moveItem, needsHandoff, type BoardSlot } from './model';

const YOU: PlanActor = { kind: 'user', userId: 'me' };

/** On mock data: the board artboard's plan; drags change it for the page's lifetime. */
const MockPlanBoard = component<ProjectPageProps>(({ props }) => {
    const now = Date.now();
    const plan = boardFixture(props.project.id, now);
    const st = signal({ items: (plan?.items ?? []) as readonly PlanItem[] });
    const move = (id: number, slot: BoardSlot, note?: string): void => {
        st.items = moveItem(st.items, id, slot, { you: YOU, at: Date.now(), ...(note ? { note } : {}) });
    };
    return () => (
        <BoardView projectId={props.project.id} title={plan?.title ?? 'Plan'} items={st.items} members={props.project.members} lookup={agentNamed} you={USER.name} now={now} onMove={move} />
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
    const st = signal({ refused: '' });
    const items = (): readonly PlanItem[] => {
        const doc = planOf(store.docs(), route.query.plan);
        return doc ? planItems(doc.plan) : [];
    };
    const move = (id: number, slot: BoardSlot, note?: string): void => {
        const all = items();
        const item = all.find((i) => i.id === id);
        const writes = store.writes;
        if (!item || !writes) return;
        st.refused = '';
        if (slot.column === 'you') {
            // The viewer's user id is not on the page yet (#927), so the actor cannot be told who "you" are.
            st.refused = `Could not move #${id}: assigning to yourself from the board is not ready yet (#927).`;
            return;
        }
        const to: PlanActor | null = slot.column === 'open' ? null : { kind: 'agent', agentId: slot.column.slice('agent:'.length) as AgentId };
        const now = Date.now();
        if (note?.trim() && needsHandoff(item, slot, now)) {
            void writes.handoff(id, to, note.trim());
            return;
        }
        if (columnOf(item) === slot.column && slot.column === 'open') return;
        void writes.assign(id, to, to === null ? undefined : assignIndex(item, slot, boardColumns(all, props.project.members, now)));
    };
    return () => {
        const doc = planOf(store.docs(), route.query.plan);
        const note = st.refused || store.note();
        return (
            <>
                {note ? <p data-plan-note="" role="alert">{note}</p> : null}
                <BoardView projectId={props.project.id} title={doc?.plan.title ?? 'Plan'} items={items()} members={props.project.members} lookup={directory.lookup} you="You" now={Date.now()} onMove={move} />
            </>
        );
    };
}, { name: 'LivePlanBoard' });

/** The Plan board view (#755, PRJ-13): columns by agent, limits, drag to assign and reorder. */
export const PlanBoard = component<ProjectPageProps>(({ props }) => () => (
    dataMode() === 'live' ? <LivePlanBoard project={props.project} /> : <MockPlanBoard project={props.project} />
), { name: 'PlanBoard' });
