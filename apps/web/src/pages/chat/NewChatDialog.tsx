import { component, signal, type Define } from 'sigx';
import { ConfirmDialog } from '@agentic/ui';
import type { AgentIdentity } from './live';

export type NewChatDialogProps =
    & Define.Model<boolean>
    /** The workspace's agents to pick members from. */
    & Define.Prop<'agents', readonly AgentIdentity[], true>
    & Define.Prop<'busy', boolean>
    & Define.Event<'create', { readonly agentIds: readonly string[]; readonly coordinator: string | null }>
    & Define.Event<'cancel'>;

/**
 * "New chat" (CHT-01, CHT-07): pick one or more agents, optionally name a
 * coordinator among them. Every picked member sees all history — the chat
 * is new, there is none to hide. A direct chat is one agent; a group is
 * several; a coordinator is optional (a single global assistant is not
 * required).
 */
export const NewChatDialog = component<NewChatDialogProps>(({ props, emit }) => {
    const st = signal({ picked: [] as string[], coordinator: '' });
    const toggle = (id: string, on: boolean): void => {
        st.picked = on ? [...new Set([...st.picked, id])] : st.picked.filter((p) => p !== id);
        if (!on && st.coordinator === id) st.coordinator = '';
    };
    return () => (
        <ConfirmDialog
            model={props.model}
            title="New chat"
            description="Who is in it? Mention an agent to address it; otherwise the coordinator answers, or the only member does."
            confirmLabel="Create chat"
            danger={false}
            busy={props.busy}
            onConfirm={() => emit('create', { agentIds: st.picked, coordinator: st.coordinator || null })}
            onCancel={() => emit('cancel')}
        >
            <fieldset data-new-chat-members>
                <legend>Members</legend>
                {props.agents.length ? props.agents.map((a) => (
                    <label>
                        <input type="checkbox" name="member" value={a.id} checked={st.picked.includes(a.id)} onChange={(e: Event) => toggle(a.id, (e.target as HTMLInputElement).checked)} />
                        {' '}{a.name}{a.role ? <span data-member-role> · {a.role}</span> : null}
                    </label>
                )) : <p data-panel-note>No agents yet — create one under Agents first.</p>}
            </fieldset>
            <label data-new-chat-coordinator>
                <span>Coordinator</span>
                <select data-scope="select" data-part="select" value={st.coordinator} onChange={(e: Event) => { st.coordinator = (e.target as HTMLSelectElement).value; }}>
                    <option value="">None</option>
                    {st.picked.map((id) => {
                        const a = props.agents.find((x) => x.id === id);
                        return <option value={id}>{a?.name ?? id}</option>;
                    })}
                </select>
            </label>
        </ConfirmDialog>
    );
});
