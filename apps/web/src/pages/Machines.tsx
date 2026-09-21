import { component, signal, type Define } from 'sigx';
import type { MachineUpdateView } from '@agentic/platform';
import { EmptyState } from '@agentic/ui';
import { environmentsOf, opsAgent, opsHarness, opsMachines, opsQuota, opsUpdate, platformRow, queuedFor, type OpsMachine } from '../mock/ops';
import { dataMode } from '../data-mode';
import { MachineGroup, PlatformRow, mockDefaultFor } from './machines/MachineGroup';
import { LiveMachines } from './machines/LiveMachines';
import { UpdateAll, type UpdateAllEntry, type UpdateAllResult } from './machines/UpdateAll';
import { harnessUpdates } from './machines/harness';
import { updateBadge } from './machines/update';
import { LinkButton } from './ops/LinkButton';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar } from '../components/topbar';

export type MachinesViewProps = Define.Prop<'machines', readonly OpsMachine[], true>;

/**
 * `/machines` — one bordered group per paired machine with its
 * environments in three columns, the `platform` row for `anthropic-api`
 * at the bottom, and the dashed "Pair a machine" card when there is no
 * machine at all (`docs/design/HANDOFF.md` → Machines).
 */
export const MachinesView = component<MachinesViewProps>(({ props }) => {
    // The sample daemons' update states (#367); "Update all" asks them here, the way the live page asks each Machine.
    const st = signal({ updates: Object.fromEntries(props.machines.map(m => [m.id, opsUpdate(m.id)])) as Record<string, MachineUpdateView>, results: null as UpdateAllResult[] | null });
    const updateAll = (targets: readonly UpdateAllEntry[]): void => {
        const updates = { ...st.updates };
        for (const t of targets) {
            const v = updates[t.id]!;
            updates[t.id] = { ...v, pending: { requestId: `upd_${t.id}`, target: v.available?.version ?? '', mode: 'drain', from: v.build?.version ?? '', requestedAt: 0, deadline: 0, by: 'user:andy' }, draining: { requestId: `upd_${t.id}`, since: 0 } };
        }
        st.updates = updates;
        st.results = targets.map(t => ({ id: t.id, name: t.name, ok: true, text: 'asked to update when idle' }));
    };
    return () => (
        <OpsPage page="machines" title="Machines">
            <UpdateAll machines={props.machines.map(m => ({ id: m.id, name: m.name, update: st.updates[m.id] ?? null }))} results={st.results} onRun={updateAll} />
            {props.machines.map(m => <MachineGroup machine={m} environments={environmentsOf(m.id)} queued={queuedFor} defaultFor={mockDefaultFor} quota={opsQuota} update={updateBadge(st.updates[m.id])} harnessUpdates={harnessUpdates(opsHarness(m.id))} />)}
            <PlatformRow defaultFor={platformRow.defaultFor.map(id => ({ name: opsAgent(id).name, hue: opsAgent(id).hue }))} caption={platformRow.caption} keyStatus={platformRow.key} keyLabel={platformRow.keyLabel} />
            {props.machines.length === 0 ? <EmptyState variant="machines" /> : null}
        </OpsPage>
    );
});

defineTopbar('machines', () => ({ actions: () => <LinkButton to="/pair" intent="primary" icon="plus">Pair a machine</LinkButton> }));

/** `/machines`: the workspace's paired machines on the platform (`LiveMachines`, #144), or the mock workspace. */
export const Machines = component(() => () => (dataMode() === 'live' ? <LiveMachines /> : <MachinesView machines={opsMachines} />));
