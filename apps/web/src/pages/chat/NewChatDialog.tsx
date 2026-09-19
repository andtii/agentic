import { component, signal, type Define } from 'sigx';
import { AgentTile, ConfirmDialog, EnvironmentLine, Icon, QuotaBadge, type WorkdirEnvironment } from '@agentic/ui';
import type { AgentIdentity } from './live';
import { memberQuota } from './quota';

export type NewChatDialogProps =
    & Define.Model<boolean>
    /** The workspace's agents to pick members from. */
    & Define.Prop<'agents', readonly AgentIdentity[], true>
    /** The workspace's environments with their accounts' limits (#315): each card shows where its agent runs and the headroom there. */
    & Define.Prop<'environments', readonly WorkdirEnvironment[]>
    & Define.Prop<'busy', boolean>
    & Define.Event<'create', { readonly agentIds: readonly string[]; readonly coordinator: string | null }>
    & Define.Event<'cancel'>;

/**
 * "New chat" (CHT-01, CHT-07): pick one or more agents from cards, optionally
 * name a coordinator among them. Every picked member sees all history — the
 * chat is new, there is none to hide. A direct chat is one agent; a group is
 * several; a coordinator is optional (a single global assistant is not
 * required).
 *
 * Each card says where the agent runs (machine / runtime / account) and how
 * close that account is to its plan limits (#315), so the person choosing
 * who works can see which one has headroom. A card is a label over a
 * visually hidden checkbox, so the keyboard and a screen reader get a plain
 * checkbox; the coordinator is a radio on the picked cards.
 */
export const NewChatDialog = component<NewChatDialogProps>(({ props, emit }) => {
    const st = signal({ picked: [] as string[], coordinator: '', attempted: false });
    const toggle = (id: string, on: boolean): void => {
        st.picked = on ? [...new Set([...st.picked, id])] : st.picked.filter((p) => p !== id);
        if (!on && st.coordinator === id) st.coordinator = '';
        if (on) st.attempted = false;
    };
    const nameOf = (id: string): string => props.agents.find((a) => a.id === id)?.name ?? id;
    return () => {
        const group = st.picked.length > 1;
        return (
            <ConfirmDialog
                model={props.model}
                title="New chat"
                description="Who is in it? Pick one agent for a direct chat, or several for a group. Each card shows where the agent runs and how much of that account’s plan is left."
                confirmLabel={st.picked.length > 1 ? `Create chat with ${st.picked.length}` : 'Create chat'}
                danger={false}
                busy={props.busy}
                onConfirm={() => {
                    // A chat needs at least one member (CHT-01): confirming with none picked keeps the dialog open.
                    if (!st.picked.length) {
                        st.attempted = true;
                        return;
                    }
                    emit('create', { agentIds: st.picked, coordinator: st.coordinator || null });
                }}
                onCancel={() => emit('cancel')}
            >
                <fieldset data-new-chat-members data-new-chat-grid>
                    <legend>Members</legend>
                    {props.agents.length ? props.agents.map((a) => {
                        const picked = st.picked.includes(a.id);
                        return (
                            <div key={a.id} data-new-chat-agent={a.id} data-picked={picked ? '' : undefined}>
                                <label data-new-chat-pick>
                                    <input data-visually-hidden type="checkbox" name="member" value={a.id} checked={picked} onChange={(e: Event) => toggle(a.id, (e.target as HTMLInputElement).checked)} />
                                    <span data-new-chat-head>
                                        <AgentTile name={a.name} hue={a.hue} size={32} />
                                        <span data-new-chat-who>
                                            <span data-new-chat-name>{a.name}</span>
                                            {a.role ? <span data-member-role>{a.role}</span> : null}
                                        </span>
                                        <span data-new-chat-check aria-hidden="true">{picked ? <Icon name="check" size={12} /> : null}</span>
                                    </span>
                                    <EnvironmentLine tone="muted" {...a.environment} />
                                    {props.environments ? <span data-new-chat-quota><QuotaBadge {...memberQuota(a, undefined, props.environments)} /></span> : null}
                                </label>
                                {picked && group ? (
                                    <label data-new-chat-coordinator-pick>
                                        <input type="radio" name="coordinator" value={a.id} checked={st.coordinator === a.id} onChange={() => { st.coordinator = a.id; }} />
                                        <span>Coordinator</span>
                                    </label>
                                ) : null}
                            </div>
                        );
                    }) : <p data-panel-note>No agents yet — create one under Agents first.</p>}
                </fieldset>
                <p data-new-chat-summary aria-live="polite">
                    {!st.picked.length
                        ? (st.attempted ? <span data-new-chat-required role="alert">Pick at least one agent.</span> : 'Nobody picked yet.')
                        : !group
                            ? `A direct chat with ${nameOf(st.picked[0]!)}.`
                            : st.coordinator
                                ? <>A group of {st.picked.length}. {nameOf(st.coordinator)} answers unless you mention someone. <button type="button" data-link-button onClick={() => { st.coordinator = ''; }}>No coordinator</button></>
                                : `A group of ${st.picked.length}, no coordinator: mention an agent to address it.`}
                </p>
            </ConfirmDialog>
        );
    };
});
