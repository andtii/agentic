/**
 * The "Add A2A peer" button and dialog on `/plugins` (#246), over the
 * workspace Registry: the token first (`setSecret`, when one is given), then
 * the peer's runtime plugin (`register`, on, granted what it declares) — so a
 * refused token leaves no half-added peer behind. The live overview then lists
 * it with the runtimes, and the agent form offers it.
 */
import { component, signal, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import { Button } from '@agentic/ui';
import type { ActorDefs } from '../../actors/defs';
import { AddA2aPeerDialog } from './AddA2aPeerDialog';
import { peerSetup, type A2aPeerDraft } from './a2a-peer';
import { registryErrorText } from './model';

export type AddA2aPeerProps =
    & Define.Prop<'defs', ActorDefs, true>
    /** The workspace Registry's key; `null` while signed out. */
    & Define.Prop<'registryKey', string | null, true>
    /** Every plugin id the workspace lists. */
    & Define.Prop<'taken', readonly string[], true>;

export const AddA2aPeer = component<AddA2aPeerProps>(({ props }) => {
    const st = signal({ open: false, busy: false, error: '', added: '' });
    const add = async (draft: A2aPeerDraft): Promise<void> => {
        const k = props.registryKey;
        if (!k || st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            const { manifest, secret } = peerSetup(draft);
            const registry = actor(props.defs.Registry, k);
            if (secret) await registry.setSecret(secret.name, secret.value);
            await registry.register(manifest, { enabled: true, grant: 'declared' });
            st.added = manifest.name;
            st.open = false;
        } catch (e) {
            st.error = registryErrorText(e);
        } finally {
            st.busy = false;
        }
    };
    return () => (
        <div data-add-a2a-peer>
            <Button intent="default" icon="plus" disabled={!props.registryKey} onClick={() => { st.error = ''; st.added = ''; st.open = true; }}>Add A2A peer</Button>
            {st.added ? <span data-a2a-peer-added role="status">Added {st.added}. Put an agent on it from the agent's config.</span> : null}
            <AddA2aPeerDialog model={() => st.open} busy={st.busy} taken={props.taken} error={st.error} onAdd={(d: A2aPeerDraft) => { void add(d); }} onCancel={() => { st.open = false; st.error = ''; }} />
        </div>
    );
});
