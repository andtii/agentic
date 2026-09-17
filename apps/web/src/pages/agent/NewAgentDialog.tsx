import { component, signal, type Define } from 'sigx';
import { ConfirmDialog, TextField } from '@agentic/ui';
import type { NewAgentInput } from './live';

export type NewAgentDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'busy', boolean>
    & Define.Event<'create', NewAgentInput>
    & Define.Event<'cancel'>;

/**
 * "New agent" (AGT-02, #35): a name and a role are enough to create one on
 * the platform runtime; everything else is edited on the agent's Config tab,
 * where each save is a new version. Confirming without a name keeps the
 * dialog open with the field marked.
 */
export const NewAgentDialog = component<NewAgentDialogProps>(({ props, emit }) => {
    const st = signal({ name: '', role: '', attempted: false });
    return () => (
        <ConfirmDialog
            model={props.model}
            title="New agent"
            description="Give it a name and what it is for. It runs on the platform (Anthropic API) until you pick another runtime in its config."
            confirmLabel="Create agent"
            danger={false}
            busy={props.busy}
            onConfirm={() => {
                if (!st.name.trim()) {
                    st.attempted = true;
                    return;
                }
                emit('create', { name: st.name, role: st.role });
            }}
            onCancel={() => emit('cancel')}
        >
            <div data-new-agent-fields>
                <TextField model={() => st.name} name="agent-name" label="Name" required error={st.attempted && !st.name.trim() ? 'A name is required.' : undefined} />
                <TextField model={() => st.role} name="agent-role" label="Role" description="What this agent is responsible for." />
            </div>
        </ConfirmDialog>
    );
});
