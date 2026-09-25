import { component, signal, type Define } from 'sigx';
import { Select } from '@sigx/zero';
import { Checkbox, Field } from '@sigx/zero-daisyui/components';
import { Button, FormDialog, TextField } from '@agentic/ui';
import type { MockChatMember } from '../../mock/workspace';
import type { AgentLookup } from './live';
import type { MachineEntry } from '../ops/environments';

/** The coordinator's "None" and the machine's "No particular machine" as Select items: never an agent or machine id. */
export const NONE = '*';

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
    /** `ChatSummary.archived` (#884): the dialog offers Restore instead of Archive. */
    & Define.Prop<'archived', boolean>
    & Define.Event<'save', ChatSettingsChange>
    /** Archive (`true`) or restore (`false`) the chat (#884, `Chat.archive`) — at once, not with Save. */
    & Define.Event<'archive', boolean>
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
 *
 * A form on the kit `FormDialog` (#592): the title posts as `title` and each
 * member ticked for removal as `remove`, as before; the coordinator and the
 * machine are zero Selects that post nothing. Their "None" and "No
 * particular machine" are items of their own (`NONE`), since zero's Select
 * keeps `null` for "nothing chosen" and offers no way back to it.
 */
export const ChatSettingsDialog = component<ChatSettingsDialogProps>(({ props, emit }) => {
    const coordinatorOf = (): string => props.members.find((m) => m.coordinator)?.agentId ?? '';
    const st = signal({ title: props.title, coordinator: (coordinatorOf() || NONE) as string | null, remove: [] as string[], machineId: (props.machineId || NONE) as string | null });
    /** A Select's pick as `settingsChange` reads it: `''` for none. */
    const picked = (v: string | null): string => (v && v !== NONE ? v : '');
    const machineChanged = (): boolean => picked(st.machineId) !== (props.machineId ?? '');
    const save = (): void => {
        const form = { title: st.title, coordinator: picked(st.coordinator), remove: st.remove, machineId: picked(st.machineId) };
        emit('save', settingsChange({ title: props.title, coordinator: coordinatorOf() || null, machineId: props.machineId ?? '' }, form));
    };
    return () => {
        const machineId = picked(st.machineId);
        return (
            <FormDialog
                model={props.model}
                title="Chat settings"
                description="Rename the chat, choose who answers when nobody is mentioned, move it to another machine, or take an agent out of it."
                submitLabel="Save settings"
                busy={props.busy}
                onSubmit={save}
                onCancel={() => emit('cancel')}
            >
                <div data-new-chat-coordinator data-chat-settings-title>
                    <TextField model={() => st.title} name="title" label="Title" maxlength={120} placeholder="Titled by its members" />
                </div>
                <div data-new-chat-coordinator data-chat-settings-coordinator>
                    <Field.Root>
                        <Field.Label>Coordinator</Field.Label>
                        <Select.Root
                            model={() => st.coordinator}
                            items={[NONE, ...props.members.filter((m) => !st.remove.includes(m.agentId)).map((m) => m.agentId)]}
                            itemLabel={(id) => (id === NONE ? 'None' : props.lookup(id).name)}
                        />
                    </Field.Root>
                </div>
                {props.machines?.length ? (
                    <div data-new-chat-coordinator data-chat-settings-machine>
                        <Field.Root>
                            <Field.Label>Machine</Field.Label>
                            <Select.Root
                                model={() => st.machineId}
                                items={[{ id: NONE, name: 'No particular machine', online: true }, ...props.machines]}
                                itemValue={(m) => m.id}
                                itemLabel={(m) => `${m.name}${m.online ? '' : ' (offline)'}`}
                            />
                        </Field.Root>
                        {machineChanged() ? <span data-chat-settings-machine-note role="status">Each member starts a fresh session {machineId ? `on ${props.machines.find((m) => m.id === machineId)?.name ?? machineId}` : 'where it runs next'} at its next message; work in flight finishes where it runs; the chat's history stays.</span> : null}
                    </div>
                ) : null}
                <fieldset data-new-chat-members data-chat-settings-remove>
                    <legend>Remove from this chat</legend>
                    {props.members.length ? props.members.map((m) => {
                        const a = props.lookup(m.agentId);
                        return (
                            <Checkbox.Root model={() => st.remove} name="remove" value={m.agentId}>
                                {a.name}{a.role ? <span data-member-role> · {a.role}</span> : null}
                            </Checkbox.Root>
                        );
                    }) : <p data-panel-note>Nobody is in this chat yet.</p>}
                </fieldset>
                <div data-chat-settings-archive style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-sm)">
                    <span data-panel-note>{props.archived ? 'Archived: out of the chat list, kept under Archived.' : 'Archive to take it out of the chat list; the thread and its members stay.'}</span>
                    <Button type="button" intent="default" icon={props.archived ? 'back' : 'download'} disabled={props.busy} onClick={() => emit('archive', !props.archived)}>{props.archived ? 'Restore chat' : 'Archive chat'}</Button>
                </div>
            </FormDialog>
        );
    };
});
