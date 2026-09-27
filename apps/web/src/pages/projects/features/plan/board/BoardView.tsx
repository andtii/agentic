/**
 * The Plan board (#755, PRJ-13): a column for Not assigned, each agent and You — WORKING, then QUEUE in order.
 * Dragging a card assigns or reorders it, with the pointer or the keyboard (Space picks up, arrows move, Space or
 * Enter drops, Escape cancels). Dropping a card an agent is working asks for a handoff note first. Board
 * `docs/design/projects/boards/PlanBoard.dc.html`, docs/design/projects/HANDOFF.md → "Board view".
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import type { Plan, PlanActor, PlanItem, ProjectMembers } from '@agentic/core';
import { formatRef } from '@agentic/core';
import { AgentTile, FormDialog, Icon, TextareaField } from '@agentic/ui';
import type { AgentLookup } from '../../../../chat/live';
import { useFollow } from '../shared/parts';
import { PlanSwitcher, PlanViews } from '../shared/switcher';
import { boardColumns, cardMeta, columnOf, doneCount, isNoop, isWorking, needsHandoff, startSlot, stepSlot, type BoardColumn, type BoardColumnKey, type BoardSlot, type BoardStep } from './model';

export type BoardViewProps =
    & Define.Prop<'projectId', string, true>
    & Define.Prop<'title', string, true>
    & Define.Prop<'items', readonly PlanItem[], true>
    & Define.Prop<'members', ProjectMembers, true>
    & Define.Prop<'lookup', AgentLookup, true>
    /** The viewer's name, for the You column. */
    & Define.Prop<'you', string, true>
    /** ms epoch the leases count down from. */
    & Define.Prop<'now', number, true>
    /** A drop: item `id` into `slot`'s queue, with the handoff note when it was taken off the agent working it. */
    & Define.Prop<'onMove', (id: number, slot: BoardSlot, note?: string) => void, true>
    /** The project's plans (#939): the title becomes the plan switcher. */
    & Define.Prop<'plans', readonly Plan[]>
    /** The plan on the board, kept by the view toggle when the project has several. */
    & Define.Prop<'planId', string>
    & Define.Prop<'onSelectPlan', (id: string) => void>
    /** New plan from the switcher; absent, it is disabled. */
    & Define.Prop<'onNewPlan', () => void>;

interface Drag {
    readonly id: number;
    readonly slot: BoardSlot;
    readonly keyboard: boolean;
}

const KEY_STEPS: Readonly<Record<string, BoardStep>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

const GLYPH_STATES: Readonly<Record<PlanItem['state'], string>> = { ready: 'Ready', claimed: 'Claimed', 'needs-you': 'Needs you', blocked: 'Blocked', done: 'Done', stuck: 'Stuck' };

export const BoardView = component<BoardViewProps>(({ props }) => {
    const follow = useFollow();
    const st = signal({ drag: null as Drag | null, pending: null as { id: number; slot: BoardSlot } | null, asking: false, note: '', said: '' });

    const nameOf = (actor: PlanActor): string => (actor.kind === 'user' ? props.you : props.lookup(actor.agentId).name);
    const columnName = (key: BoardColumnKey): string => (key === 'open' ? 'Not assigned' : key === 'you' ? 'You' : props.lookup(key.slice('agent:'.length)).name);
    const itemOf = (id: number): PlanItem | undefined => props.items.find((i) => i.id === id);
    const columns = (): BoardColumn[] => boardColumns(props.items, props.members, props.now);
    const where = (slot: BoardSlot): string => `${columnName(slot.column)}, queue position ${slot.index + 1}`;

    const focusCard = (id: number): void => {
        setTimeout(() => document.querySelector<HTMLElement>(`[data-plan-card="${id}"]`)?.focus(), 0);
    };

    const commit = (id: number, slot: BoardSlot): void => {
        const item = itemOf(id);
        st.drag = null;
        if (!item || isNoop(item, slot, columns(), props.now)) {
            st.said = `#${id} stays where it was.`;
            return;
        }
        if (needsHandoff(item, slot, props.now)) {
            st.note = '';
            st.pending = { id, slot };
            st.asking = true;
            return;
        }
        props.onMove(id, slot);
        st.said = `Moved #${id} to ${where(slot)}.`;
        focusCard(id);
    };

    const handOff = (): void => {
        const p = st.pending;
        if (!p) return;
        st.pending = null;
        st.asking = false;
        props.onMove(p.id, p.slot, st.note);
        st.said = `Moved #${p.id} to ${where(p.slot)}; the handoff note went to its owner.`;
        focusCard(p.id);
    };

    const cancelHandoff = (): void => {
        const id = st.pending?.id;
        st.pending = null;
        st.asking = false;
        st.said = 'Handoff cancelled.';
        if (id !== undefined) focusCard(id);
    };

    const onCardKey = (item: PlanItem, e: KeyboardEvent): void => {
        const drag = st.drag;
        if (!drag || !drag.keyboard || drag.id !== item.id) {
            if (e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                const slot = startSlot(item, columns());
                st.drag = { id: item.id, slot, keyboard: true };
                st.said = `Picked up #${item.id}. Arrow keys move it, Space drops, Escape cancels.`;
            }
            return;
        }
        const step = KEY_STEPS[e.key];
        if (step) {
            e.preventDefault();
            const slot = stepSlot(item, drag.slot, step, columns());
            st.drag = { ...drag, slot };
            st.said = `#${item.id}: ${where(slot)}.`;
        } else if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
            e.preventDefault();
            commit(item.id, drag.slot);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            st.drag = null;
            st.said = `#${item.id} stays where it was.`;
        }
    };

    const onDragStart = (item: PlanItem, e: DragEvent): void => {
        e.dataTransfer?.setData('text/plain', `#${item.id}`);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        st.drag = { id: item.id, slot: startSlot(item, columns()), keyboard: false };
    };

    /** Over a column: before or after the queue card under the pointer, else the end of the queue. */
    const onDragOver = (col: BoardColumn, e: DragEvent): void => {
        const drag = st.drag;
        if (!drag || drag.keyboard) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const card = (e.target as Element | null)?.closest?.('[data-queue-index]') as HTMLElement | null;
        let index = col.queue.length;
        if (card) {
            const at = Number(card.dataset.queueIndex);
            const box = card.getBoundingClientRect();
            index = box.height > 0 && e.clientY > box.top + box.height / 2 ? at + 1 : at;
        } else if (drag.slot.column === col.key) {
            return;
        }
        if (drag.slot.column !== col.key || drag.slot.index !== index) st.drag = { ...drag, slot: { column: col.key, index } };
    };

    const onDrop = (e: DragEvent): void => {
        const drag = st.drag;
        if (!drag || drag.keyboard) return;
        e.preventDefault();
        commit(drag.id, drag.slot);
    };

    const onDragEnd = (): void => {
        if (st.drag && !st.drag.keyboard) st.drag = null;
    };

    const Card = (item: PlanItem, queueIndex: number | null): JSXElement => {
        const drag = st.drag;
        const lifted = drag?.id === item.id;
        const meta = cardMeta(item, props.items, props.now, nameOf);
        const moving = lifted && drag && drag.slot.column !== columnOf(item) ? `moving to ${columnName(drag.slot.column)}` : null;
        const chips = item.refs.filter((r) => r.kind === 'project-item' || r.kind === 'pr');
        return (
            <li key={item.id} data-plan-card-slot="" {...(queueIndex === null ? {} : { 'data-queue-index': String(queueIndex) })}>
                <div
                    data-plan-card={String(item.id)}
                    data-state={item.state}
                    data-working={isWorking(item, props.now) ? '' : undefined}
                    data-lifted={lifted ? '' : undefined}
                    tabIndex={0}
                    role="button"
                    aria-roledescription="draggable plan item"
                    aria-pressed={lifted && drag?.keyboard ? 'true' : 'false'}
                    aria-label={`#${item.id} ${item.title}`}
                    draggable={true}
                    onDragStart={(e: DragEvent) => onDragStart(item, e)}
                    onDragEnd={onDragEnd}
                    onKeyDown={(e: KeyboardEvent) => onCardKey(item, e)}
                >
                    <span data-plan-card-top>
                        <span data-plan-card-id>{`#${item.id}`}</span>
                        <span data-plan-glyph={item.state} title={GLYPH_STATES[item.state]} aria-label={GLYPH_STATES[item.state]} />
                        {chips.map((r) => <span data-plan-card-ref><Icon name="folder" size={11} />{formatRef(r)}</span>)}
                    </span>
                    <span data-plan-card-title>{item.title}</span>
                    {moving || meta.length ? <span data-plan-card-meta>{moving ?? meta.join(' · ')}</span> : null}
                </div>
            </li>
        );
    };

    const Slot = (): JSXElement => <li data-plan-board-slot="" aria-hidden="true" />;

    /** The queue with the dashed drop slot where the dragged card would land. */
    const Queue = (col: BoardColumn): JSXElement[] => {
        const drag = st.drag;
        const dragged = drag ? itemOf(drag.id) : undefined;
        const slotAt = drag && dragged && drag.slot.column === col.key && !isNoop(dragged, drag.slot, columns(), props.now) ? drag.slot.index : -1;
        const out: JSXElement[] = [];
        col.queue.forEach((item, i) => {
            if (i === slotAt) out.push(Slot());
            out.push(Card(item, i));
        });
        if (slotAt === col.queue.length) out.push(Slot());
        return out;
    };

    const Head = (col: BoardColumn): JSXElement => {
        if (col.kind === 'open') {
            const coord = props.members.coordinator;
            return (
                <header data-plan-board-head>
                    <span data-plan-board-open-tile aria-hidden="true" />
                    <span data-plan-board-who><b>Not assigned</b><small>{coord ? `${props.lookup(coord).name} assigns, or drag` : 'Drag to assign'}</small></span>
                </header>
            );
        }
        if (col.kind === 'you') {
            return (
                <header data-plan-board-head>
                    <AgentTile name={props.you} person size={24} />
                    <span data-plan-board-who><b>You</b><small>no limit</small></span>
                </header>
            );
        }
        const a = props.lookup(col.agentId!);
        const role = props.members.roles?.[col.agentId as never] ?? a.role;
        const limit = col.limit ?? 1;
        const used = col.working.length;
        return (
            <header data-plan-board-head>
                <AgentTile name={a.name} hue={a.hue} size={24} />
                <span data-plan-board-who><b>{a.name}</b>{role ? <small>{role}</small> : null}</span>
                <span data-plan-board-limit data-over={used > limit ? '' : undefined}>
                    <span data-plan-board-segments aria-hidden="true">
                        {Array.from({ length: limit }, (_, i) => <span data-segment={i < used ? 'used' : 'free'} />)}
                    </span>
                    <span data-plan-board-limit-text>{`${used}/${limit} working`}</span>
                </span>
            </header>
        );
    };

    return () => {
        const cols = columns();
        const done = doneCount(props.items);
        const pending = st.pending ? itemOf(st.pending.id) : undefined;
        const owner = pending?.claim ? props.lookup(pending.claim.agentId).name : pending?.assignee ? nameOf(pending.assignee) : '';
        const base = `/projects/${props.projectId}/plan`;
        return (
            <section aria-label="Plan board" data-plan-board="">
                <header data-plan-board-top>
                    <div>
                        <div data-plan-title-row="" style="display: flex; align-items: center; gap: 6px; min-inline-size: 0">
                            <h2 data-plan-board-title>{props.title}</h2>
                            {props.plans
                                ? <PlanSwitcher compact plans={props.plans} current={props.plans.find((p) => p.id === props.planId)} onSelect={(id: string) => props.onSelectPlan?.(id)} {...(props.onNewPlan ? { onNew: props.onNewPlan } : {})} />
                                : null}
                        </div>
                        <p data-plan-board-lede>Board by agent. Drag a card to assign it; the order in a column is the order they work.</p>
                    </div>
                    {PlanViews(props.projectId, 'board', follow, props.plans && props.plans.length > 1 ? props.planId : undefined)}
                </header>

                <div data-plan-board-columns data-dragging={st.drag ? '' : undefined}>
                    {cols.map((col) => (
                        <section
                            key={col.key}
                            data-plan-board-column={col.key}
                            data-drop-target={st.drag?.slot.column === col.key ? '' : undefined}
                            aria-label={columnName(col.key)}
                            onDragOver={(e: DragEvent) => onDragOver(col, e)}
                            onDrop={onDrop}
                        >
                            {Head(col)}
                            {col.working.length ? (
                                <div data-plan-board-group="working">
                                    <h3>WORKING</h3>
                                    <ul>{col.working.map((i) => Card(i, null))}</ul>
                                </div>
                            ) : null}
                            <div data-plan-board-group="queue">
                                <h3>{`QUEUE · ${col.queue.length}`}</h3>
                                <ul>{Queue(col)}</ul>
                            </div>
                        </section>
                    ))}
                </div>

                <footer data-plan-board-foot>
                    <span data-plan-board-done>
                        <Icon name="check" size={13} />
                        <b>{`${done} done`}</b>
                        <span>hidden on the board · <Link to={`${base}?view=list`}>show in List</Link></span>
                    </span>
                    <span data-plan-board-rule><Icon name="shield" size={13} /> An agent works its queue top to bottom. It only claims the next item when it has room under its limit.</span>
                </footer>

                <p data-plan-board-live aria-live="polite">{st.said}</p>

                {st.pending && pending ? (
                    <FormDialog
                        model={() => st.asking}
                        title={`Hand #${pending.id} to ${columnName(st.pending.slot.column)}?`}
                        description={`${owner} is working on it now. ${owner} gets this note with the handoff.`}
                        submitLabel="Hand off"
                        onSubmit={handOff}
                        onCancel={cancelHandoff}
                    >
                        <div data-plan-board-handoff>
                            <TextareaField model={() => st.note} name="note" label="Handoff note" rows={3} placeholder="Where it stands, what is left" />
                        </div>
                    </FormDialog>
                ) : null}
            </section>
        );
    };
}, { name: 'PlanBoardView' });
