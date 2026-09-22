/**
 * The folders card on mock data (`pnpm dev:mock`, #482): the machine's
 * sample policy, a "Preview" picker for every other state (web, local,
 * locked, off, a daemon without the feature), a browser over the sample
 * folder tree, and a save that applies at once the way the daemon would —
 * `~` expanded to the sample home folder, the page's policy following.
 */
import { component, signal, watch, type Define, type JSXElement } from 'sigx';
import type { DaemonFeature, HostOs, MachinePolicy } from '@agentic/core';
import { SelectField } from '@agentic/ui';
import { mockListing, opsPolicyStates, type OpsPolicyState } from '../../mock/ops';
import { BrowseDialog } from './BrowseDialog';
import { PolicyCard } from './PolicyCard';
import { policyCardState, policyRootsOf } from './policy';

const MOCK_HOME = 'C:\\Users\\andy';

export type MockPolicyCardProps =
    & Define.Prop<'machineId', string, true>
    & Define.Prop<'name', string, true>
    & Define.Prop<'os', HostOs, true>
    & Define.Prop<'online', boolean, true>
    & Define.Prop<'policy', MachinePolicy>
    & Define.Prop<'features', readonly DaemonFeature[], true>
    & Define.Prop<'likelyRoot', string>
    /** The page's policy follows the card: a preview or a save changes what the environments section sees. */
    & Define.Event<'change', { policy: MachinePolicy | undefined; features: readonly DaemonFeature[] }>;

export const MockPolicyCard = component<MockPolicyCardProps>(({ props, emit }) => {
    const st = signal({ state: '' as OpsPolicyState | '', roots: policyRootsOf(props.policy, undefined) as readonly string[], busy: false, notice: null as string | null, failure: null as string | null });
    const browse = signal({ open: false, path: null as string | null });
    watch(() => st.state, (state) => {
        if (!state) return;
        const s = opsPolicyStates[state];
        st.roots = policyRootsOf(s.policy, undefined);
        st.notice = null;
        st.failure = null;
        emit('change', { policy: s.policy, features: s.features });
    });
    const save = (): void => {
        const requested = [...st.roots];
        st.busy = true;
        st.notice = null;
        setTimeout(() => {
            st.busy = false;
            const protectedRoot = requested.find((r) => /agentic[\\/]daemon/i.test(r));
            if (protectedRoot) {
                st.failure = `A folder is inside the daemon's own folders (its configuration, state or an account profile) and cannot be allowed. ${protectedRoot} is the daemon's own.`;
                return;
            }
            const allowedRoots = requested.map((r) => (r === '~' ? MOCK_HOME : r.replace(/^~[\\/]/, `${MOCK_HOME}\\`)));
            st.failure = null;
            st.notice = 'Applied on the machine.';
            emit('change', { policy: allowedRoots.length ? { webManaged: true, allowedRoots, requested, source: 'web' } : { webManaged: false, allowedRoots: [], requested: [], source: 'web' }, features: props.features });
        }, 400);
    };
    return (): JSXElement => (
        <>
            <PolicyCard
                name={props.name}
                os={props.os}
                state={policyCardState(props.policy, props.features)}
                {...(props.policy ? { policy: props.policy } : {})}
                roots={st.roots}
                online={props.online}
                busy={st.busy}
                failure={st.failure}
                notice={st.notice}
                {...(props.likelyRoot ? { likelyRoot: props.likelyRoot } : {})}
                onAdd={(path: string) => { st.roots = [...st.roots, path]; st.notice = null; }}
                onRemove={(path: string) => { st.roots = st.roots.filter((r) => r !== path); st.notice = null; }}
                onBrowse={() => { browse.path = null; browse.open = true; }}
                onSave={save}
                onReset={() => { st.roots = policyRootsOf(props.policy, undefined); st.failure = null; }}
            >
                <div data-update-preview>
                    <SelectField
                        name="policy-preview"
                        label="Preview (mock data)"
                        model={() => st.state}
                        options={[{ value: '', label: 'This machine' }, ...(Object.keys(opsPolicyStates) as OpsPolicyState[]).map((k) => ({ value: k, label: opsPolicyStates[k].label }))]}
                    />
                </div>
            </PolicyCard>
            <BrowseDialog
                model={() => browse.open}
                machineName={props.name}
                os={props.os}
                path={browse.path}
                roots={mockListing(null)}
                listing={browse.path === null ? null : mockListing(browse.path)}
                onNavigate={(path: string | null) => { browse.path = path; }}
                onSelect={(path: string) => { if (!st.roots.includes(path)) st.roots = [...st.roots, path]; st.notice = null; }}
                onCancel={() => { browse.open = false; }}
            />
        </>
    );
});
