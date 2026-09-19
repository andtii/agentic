import { component, signal, watch, type Define } from 'sigx';
import { ConfirmDialog, TextField } from '@agentic/ui';
import { EMPTY_PEER_DRAFT, peerDraftErrors, peerRuntimeId, type A2aPeerDraft } from './a2a-peer';

export type AddA2aPeerDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'busy', boolean>
    /** Every plugin id the workspace lists — a peer's id must be new. */
    & Define.Prop<'taken', readonly string[]>
    /** What the Registry refused; nothing was stored. */
    & Define.Prop<'error', string>
    & Define.Event<'add', A2aPeerDraft>
    & Define.Event<'cancel'>;

/**
 * "Add A2A peer" (#246): a remote A2A agent becomes a runtime this workspace's
 * agents can run on. A name, the agent card URL, and a bearer token if the
 * agent needs one. Confirming with a field wrong keeps the dialog open with
 * the field marked; each opening starts empty.
 */
export const AddA2aPeerDialog = component<AddA2aPeerDialogProps>(({ props, emit }) => {
    const st = signal({ ...EMPTY_PEER_DRAFT, attempted: false });
    watch(
        () => props.model?.value === true,
        (open) => {
            if (open) Object.assign(st, { ...EMPTY_PEER_DRAFT, attempted: false });
        }
    );
    const draft = (): A2aPeerDraft => ({ name: st.name, cardUrl: st.cardUrl, token: st.token });
    return () => {
        const errors = st.attempted ? peerDraftErrors(draft(), props.taken ?? []) : {};
        return (
            <ConfirmDialog
                model={props.model}
                title="Add A2A peer"
                description="A remote agent that speaks A2A becomes a runtime: put any of your agents on it and their work runs there."
                confirmLabel="Add peer"
                danger={false}
                busy={props.busy}
                onConfirm={() => {
                    st.attempted = true;
                    if (Object.keys(peerDraftErrors(draft(), props.taken ?? [])).length) return;
                    emit('add', draft());
                }}
                onCancel={() => emit('cancel')}
            >
                <div data-a2a-peer-fields>
                    <TextField model={() => st.name} name="peer-name" label="Name" required error={errors.name} description={st.name.trim() ? `Runtime id: ${peerRuntimeId(draft())}` : 'How the agent form lists it.'} />
                    <TextField model={() => st.cardUrl} name="peer-card-url" label="Agent card URL" required type="url" placeholder="https://agent.example.com/.well-known/agent-card.json" error={errors.cardUrl} description="Its agent card, or its base URL." />
                    <TextField model={() => st.token} name="peer-token" label="Bearer token" type="password" description="Only if the agent asks for one. Sealed in the workspace's secrets; never shown again." />
                    {props.error ? <p data-chat-error role="alert">{props.error}</p> : null}
                </div>
            </ConfirmDialog>
        );
    };
});
