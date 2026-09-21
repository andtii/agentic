import { component, signal, watch, type Define } from 'sigx';
import { DEFAULT_UPDATE_SETTINGS, type HostOs } from '@agentic/core';
import type { MachineUpdateView } from '@agentic/platform';
import { SelectField } from '@agentic/ui';
import { opsAgent, opsUpdate, opsUpdateStates, workspaceTimeZone, type OpsUpdateState } from '../../mock/ops';
import { UpdateCard } from './UpdateCard';
import type { UpdateChoice } from './UpdatePolicyForm';

const MOCK_NOW = Date.parse('2026-09-17T14:20:04Z');

/**
 * The update card on mock data (`pnpm dev:mock`, #367): the machine's
 * sample state, a "Preview" picker for every other one, and actions that
 * move the card the way the platform would — a request goes pending, cancel
 * ends it, the channel and policy are kept.
 */
export const MockUpdateCard = component<Define.Prop<'machineId', string, true> & Define.Prop<'name', string, true> & Define.Prop<'os', HostOs, true> & Define.Prop<'daemonVersion', string>>(({ props }) => {
    const st = signal({ state: '' as OpsUpdateState | '', view: opsUpdate(props.machineId) as MachineUpdateView });
    watch(() => st.state, (state) => { st.view = state ? opsUpdate(props.machineId, state) : opsUpdate(props.machineId); });
    const pend = (target: string, mode: 'drain' | 'now'): void => {
        const v = st.view;
        st.view = { ...v, pending: { requestId: `upd_${Date.now()}`, target, mode, from: v.build?.version ?? '', requestedAt: MOCK_NOW, deadline: MOCK_NOW + 40 * 60_000, by: 'user:andy', phase: mode === 'drain' && v.impact.runningTurns.length ? 'draining' : 'downloading', progress: { bytes: 12_000_000, total: 48_000_000 } }, draining: { requestId: 'upd_mock', since: MOCK_NOW } };
    };
    const save = (choice: UpdateChoice): void => {
        const v = st.view;
        st.view = {
            ...v,
            channel: choice.channel ?? DEFAULT_UPDATE_SETTINGS.defaultChannel,
            policy: choice.policy ?? DEFAULT_UPDATE_SETTINGS.defaultPolicy,
            inherited: { channel: choice.channel === null, policy: choice.policy === null }
        };
    };
    return () => (
        <UpdateCard
            update={st.view}
            name={props.name}
            os={props.os}
            daemonVersion={props.daemonVersion}
            origin="https://agentic.example"
            timeZone={workspaceTimeZone}
            defaults={DEFAULT_UPDATE_SETTINGS}
            turnLabel={(t) => `${opsAgent(t.agentId).name} · ${t.sessionId}`}
            now={MOCK_NOW}
            onRequest={(mode: 'drain' | 'now') => pend(st.view.available?.version ?? '', mode)}
            onRollback={() => pend('previous', 'drain')}
            onCancel={() => {
                const { pending, draining: _d, ...rest } = st.view;
                st.view = { ...rest, ...(pending ? { last: { requestId: pending.requestId, from: pending.from, to: pending.target, outcome: 'cancelled', at: MOCK_NOW } } : {}) };
            }}
            onSaveUpdates={save}
        >
            <div data-update-preview>
                <SelectField
                    name="update-preview"
                    label="Preview (mock data)"
                    model={() => st.state}
                    options={[{ value: '', label: 'This machine' }, ...(Object.keys(opsUpdateStates) as OpsUpdateState[]).map((k) => ({ value: k, label: opsUpdateStates[k].label }))]}
                />
            </div>
        </UpdateCard>
    );
});
