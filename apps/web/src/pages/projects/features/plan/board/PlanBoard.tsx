import { component, signal } from 'sigx';
import type { PlanActor, PlanItem } from '@agentic/core';
import { useActorDefs, useViewer } from '../../../../../actors/defs';
import { dataMode } from '../../../../../data-mode';
import { USER, agentNamed } from '../../../../../mock/workspace';
import { useAgentDirectory } from '../../../../chat/directory';
import type { ProjectPageProps } from '../../../layout/types';
import { BoardView } from './BoardView';
import { boardFixture } from './fixture';
import { moveItem, type BoardSlot } from './model';

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
 * Live: the project's members as columns. The plan store arrives with the Plan feature (#753); until the board
 * reads it there are no items to show, and a drop changes only this page's copy.
 */
const LivePlanBoard = component<ProjectPageProps>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const st = signal({ items: [] as readonly PlanItem[] });
    const move = (id: number, slot: BoardSlot, note?: string): void => {
        st.items = moveItem(st.items, id, slot, { you: YOU, at: Date.now(), ...(note ? { note } : {}) });
    };
    return () => (
        <BoardView projectId={props.project.id} title="Plan" items={st.items} members={props.project.members} lookup={directory.lookup} you="You" now={Date.now()} onMove={move} />
    );
}, { name: 'LivePlanBoard' });

/** The Plan board view (#755, PRJ-13): columns by agent, limits, drag to assign and reorder. */
export const PlanBoard = component<ProjectPageProps>(({ props }) => () => (
    dataMode() === 'live' ? <LivePlanBoard project={props.project} /> : <MockPlanBoard project={props.project} />
), { name: 'PlanBoard' });
