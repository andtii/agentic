import { component, signal, watch, type Define } from 'sigx';
import type { HostOs } from '@agentic/core';
import type { HarnessResultView } from '@agentic/platform';
import { SelectField } from '@agentic/ui';
import { environmentsOf, opsAgent, opsHarness, opsHarnessStates, opsHostedSessions, type OpsHarnessState, type OpsHarnessView } from '../../mock/ops';
import { HarnessCard, type HarnessAsk } from './HarnessCard';
import { harnessRows, removeBlocked } from './harness';

/**
 * "Runtimes on this machine" on mock data (`pnpm dev:mock`, #370): the
 * machine's sample state, a "Preview" picker for every other one, and asks
 * that move the card the way the platform would — Install / Update go
 * pending, a Remove the machine still uses is refused with the reason.
 */
export const MockHarnessCard = component<Define.Prop<'machineId', string, true> & Define.Prop<'name', string, true> & Define.Prop<'os', HostOs, true> & Define.Prop<'online', boolean, true>>(({ props }) => {
    const st = signal({ state: '' as OpsHarnessState | '', view: opsHarness(props.machineId) as OpsHarnessView, failure: null as { runtime: string; text: string } | null });
    watch(() => st.state, (state) => { st.view = state ? opsHarness(props.machineId, state) : opsHarness(props.machineId); st.failure = null; });
    const source = () => ({ ...st.view, environments: environmentsOf(props.machineId), activeSessions: opsHostedSessions(props.machineId), pending: [] });
    const ask = (a: HarnessAsk): void => {
        const row = harnessRows(source()).find((r) => r.runtime === a.runtime);
        st.failure = null;
        if (!row) return;
        const blocked = a.op === 'remove' ? removeBlocked(row) : null;
        if (blocked) {
            st.failure = { runtime: a.runtime, text: blocked };
            return;
        }
        const request: HarnessResultView = { requestId: `harness_${Date.now()}`, op: a.op, runtime: a.runtime, mode: a.mode, status: 'pending', requestedAt: Date.now(), phase: a.op === 'remove' ? 'applying' : 'downloading', ...(row.installed ? { from: row.installed } : {}), ...(a.op !== 'remove' && row.available ? { to: row.available } : {}) };
        st.view = { ...st.view, request };
    };
    return () => (
        <HarnessCard
            rows={harnessRows(source())}
            name={props.name}
            os={props.os}
            origin="https://agentic.example"
            online={props.online}
            able={st.view.features.includes('harness')}
            current={st.view.request ?? null}
            failure={st.failure}
            turnLabel={(t) => `${opsAgent(t.agentId).name} · ${t.sessionId}`}
            onRequest={ask}
        >
            <div data-update-preview>
                <SelectField
                    name="harness-preview"
                    label="Preview (mock data)"
                    model={() => st.state}
                    options={[{ value: '', label: 'This machine' }, ...(Object.keys(opsHarnessStates) as OpsHarnessState[]).map((k) => ({ value: k, label: opsHarnessStates[k].label }))]}
                />
            </div>
        </HarnessCard>
    );
});
