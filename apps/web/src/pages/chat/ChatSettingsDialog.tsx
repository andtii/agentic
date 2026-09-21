import { component, signal, type Define } from 'sigx';
import { ConfirmDialog } from '@agentic/ui';
import type { MockChatMember } from '../../mock/workspace';
import type { AgentLookup } from './live';
import type { MachineEntry } from '../ops/environments';

/** What the dialog's confirm asks for — only what changed. */
export interface ChatSettingsChange {
    /** A new title (`Chat.rename`); absent when it is unchanged or blank. */
    readonly title?: string;
    /** A new coordinator, or `null` for none (`Chat.setCoordinator`); absent when unchanged. */
    readonly coordinator?: string | null;
    /** Members to remove (`Chat.removeAgent`). */
    readonly remove: readonly string[];
    /** The machine the chat runs on from now (`Chat.setMachine`, #414), or `null` for none; absent when unchanged. */
    readonly machineId?: string | null;
}

export type ChatSettingsDialogProps =
    & Define.Model<boolean>
    /** The stored title (`Chat.get().title`); empty while the chat is titled by its members. */
    & Define.Prop<'title', string, true>
    & Define.Prop<'members', readonly MockChatMember[], true>
    & Define.Prop<'lookup', AgentLookup, true>
    /** The chat's machine (`ChatSummary.machineId`, #414), `''` for none; with `machines`, the dialog offers a change. */
    & Define.Prop<'machineId', string>
    & Define.Prop<'machines', readonly MachineEntry[]>
    & Define.Prop<'busy', boolean>
    & Define.Event<'save', ChatSettingsChange>
    & Define.Event<'cancel'>;

/**
 * The change between what the chat has and what the form holds. Pure, so
 * the rule is tested without a dialog. Removing the coordinator already
 * leaves the chat without one (`Chat.removeAgent`), so that alone is not a
 * coordinator change; the page removes first, then names the coordinator.
 */
export function settingsChange(current: { title: string; coordinator: string | null; machineId?: string }, form: { title: string; coordinator: string; remove: readonly string[]; machineId?: string }): ChatSettingsChange {
    const title = form.title.replace(/\s+/g, ' ').trim();
    const after = current.coordinator !== null && form.remove.includes(current.coordinator) ? null : current.coordinator;
    const wanted = form.coordinator && !form.remove.includes(form.coordinator) ? form.coordinator : null;
    const machine = form.machineId === undefined || form.machineId === (current.machineId ?? '') ? undefined : form.machineId || null;
    return {
        ...(title && title !== current.title ? { title } : {}),
        ...(wanted !== after ? { coordinator: wanted } : {}),
        remove: form.remove,
        ...(machine !== undefined ? { machineId: machine } : {})
    };
}

/**
 * "Chat settings" (#152): the title (#124), the coordinator (CHT-07) and
 * who is in the chat — adding a member is the context panel's "Add agent",
 * where history access is asked (CHT-04); leaving is here. The page mounts
 * it while it is open, so the form starts from the chat each time.
 */
export const ChatSettingsDialog = component<ChatSettingsDialogProps>(({ props, emit }) => {
    const coordinatorOf = (): string => props.members.find((m) => m.coordinator)?.agentId ?? '';
    const st = signal({ title: props.title, coordinator: coordinatorOf(), remove: [] as string[], machineId: props.machineId ?? '' });
    const machineChanged = (): boolean => st.machineId !== (props.machineId ?? '');
    const toggle = (id: string, on: boolean): void => {
        st.remove = on ? [...new Set([...st.remove, id])] : st.remove.filter((r) => r !== id);
    };
    return () => (
        <ConfirmDialog
            model={props.model}
            title="Chat settings"
            description="Rename the chat, choose who answers when nobody is mentioned, move it to another machine, or take an agent out of it."
            confirmLabel="Save settings"
            danger={false}
            busy={props.busy}
            onConfirm={() => emit('save', settingsChange({ title: props.title, coordinator: coordinatorOf() || null, machineId: props.machineId ?? '' }, st))}
            onCancel={() => emit('cancel')}
        >
            <label data-new-chat-coordinator data-chat-settings-title>
                <span>Title</span>
                <input type="text" name="title" maxLength={120} placeholder="Titled by its members" data-scope="input" data-part="input" value={st.title} onInput={(e: Event) => { st.title = (e.target as HTMLInputElement).value; }} />
            </label>
            <label data-new-chat-coordinator data-chat-settings-coordinator>
                <span>Coordinator</span>
                <select data-scope="select" data-part="select" value={st.coordinator} onChange={(e: Event) => { st.coordinator = (e.target as HTMLSelectElement).value; }}>
                    <option value="">None</option>
                    {props.members.filter((m) => !st.remove.includes(m.agentId)).map((m) => <option value={m.agentId}>{props.lookup(m.agentId).name}</option>)}
                </select>
            </label>
            {props.machines?.length ? (
                <label data-new-chat-coordinator data-chat-settings-machine>
                    <span>Machine</span>
                    <select data-scope="select" data-part="select" value={st.machineId} onChange={(e: Event) => { st.machineId = (e.target as HTMLSelectElement).value; }}>
                        <option value="">No particular machine</option>
                        {props.machines.map((m) => <option value={m.id}>{m.name}{m.online ? '' : ' (offline)'}</option>)}
                    </select>
                    {machineChanged() ? <span data-chat-settings-machine-note role="status">Each member starts a fresh session {st.machineId ? `on ${props.machines.find((m) => m.id === st.machineId)?.name ?? st.machineId}` : 'where it runs next'} at its next message; work in flight finishes where it runs; the chat's history stays.</span> : null}
                </label>
            ) : null}
            <fieldset data-new-chat-members data-chat-settings-remove>
                <legend>Remove from this chat</legend>
                {props.members.length ? props.members.map((m) => {
                    const a = props.lookup(m.agentId);
                    return (
                        <label>
                            <input type="checkbox" name="remove" value={m.agentId} checked={st.remove.includes(m.agentId)} onChange={(e: Event) => toggle(m.agentId, (e.target as HTMLInputElement).checked)} />
                            {' '}{a.name}{a.role ? <span data-member-role> · {a.role}</span> : null}
                        </label>
                    );
                }) : <p data-panel-note>Nobody is in this chat yet.</p>}
            </fieldset>
        </ConfirmDialog>
    );
});
