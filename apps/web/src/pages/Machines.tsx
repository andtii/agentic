import { component, type Define } from 'sigx';
import { EmptyState } from '@agentic/ui';
import { environmentsOf, opsMachines, platformRow, type OpsMachine } from '../mock/ops';
import { MachineGroup, PlatformRow } from './machines/MachineGroup';
import { LinkButton } from './ops/LinkButton';
import { OpsPage } from './ops/OpsPage';

export type MachinesViewProps = Define.Prop<'machines', readonly OpsMachine[], true>;

/**
 * `/machines` — one bordered group per paired machine with its
 * environments in three columns, the `platform` row for `anthropic-api`
 * at the bottom, and the dashed "Pair a machine" card when there is no
 * machine at all (`docs/design/HANDOFF.md` → Machines).
 */
export const MachinesView = component<MachinesViewProps>(({ props }) => () => (
    <OpsPage page="machines" title="Machines" slots={{ actions: () => <LinkButton to="/pair" intent="primary" icon="plus">Pair a machine</LinkButton> }}>
        {props.machines.map(m => <MachineGroup machine={m} environments={environmentsOf(m.id)} />)}
        <PlatformRow defaultFor={platformRow.defaultFor} caption={platformRow.caption} keyStatus={platformRow.key} keyLabel={platformRow.keyLabel} />
        {props.machines.length === 0 ? <EmptyState variant="machines" /> : null}
    </OpsPage>
));

export const Machines = component(() => () => <MachinesView machines={opsMachines} />);
