/**
 * `/machines` on the platform (#144): the Workspace's machine index read
 * live, each paired machine's record a live read of its own
 * (`Machine.get`: online, last seen, the environments the daemon reported
 * with their auth status), the router's parked tasks as the queued counts
 * (EXE-12), the directory's agents on the "Default for" tiles — rendered
 * as the same machine groups the mock page draws. Each environment card
 * carries its account's provider limits from `MachineView.quota` (#270).
 */
import { component, type JSXElement } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, routingKeyOf, workspaceKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { OpsPage } from '../ops/OpsPage';
import { LIVE_PLATFORM_ROW, defaultForByEnvironment, machineOf, platformAgents, queuedByEnvironment, type DefaultForAgent } from './live';
import { MachineGroup, PlatformRow } from './MachineGroup';

/** One machine's group over a live read of its record; busy (and empty) until the first value. */
const LiveMachineGroup = component<{ id: string; name: string; workspaceId: string; queued: Readonly<Record<string, number>>; defaultFor: Readonly<Record<string, readonly DefaultForAgent[]>> }>(({ props }) => {
    const defs = useActorDefs();
    const view = useActorState(defs.Machine, () => [machineKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    return (): JSXElement => {
        const v = view.value;
        if (!v) return <section data-machine-group data-machine={props.id} aria-label={props.name} aria-busy="true" />;
        return <MachineGroup machine={machineOf(v, props.name, Date.now())} environments={v.environments} queued={props.queued} defaultFor={props.defaultFor} quota={v.quota ?? {}} />;
    };
});

export const LiveMachines = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const index = useActorState(defs.Workspace, () => { const ws = viewer.workspaceId; return ws && ([workspaceKeyOf(ws), 'listMachines'] as const); }, { live: true });
    const routing = useActorState(defs.Routing, () => { const ws = viewer.workspaceId; return ws && ([routingKeyOf(ws), 'get'] as const); }, { live: true });
    return (): JSXElement => {
        const ws = viewer.workspaceId;
        const signedOut = !viewer.pending && !ws;
        const paired = (index.value ?? []).filter((m) => m.status === 'paired');
        const agents = directory.all();
        const defaultFor = defaultForByEnvironment(agents);
        return (
            <OpsPage page="machines" title="Machines">
                {ws ? paired.map((m) => <LiveMachineGroup id={m.id} name={m.name} workspaceId={ws} queued={queuedByEnvironment(routing.value ?? undefined, m.id)} defaultFor={defaultFor} />) : null}
                <PlatformRow defaultFor={platformAgents(agents)} caption={LIVE_PLATFORM_ROW.caption} keyStatus={LIVE_PLATFORM_ROW.key} keyLabel={LIVE_PLATFORM_ROW.keyLabel} />
                {signedOut
                    ? <EmptyState variant="generic" title="Sign in to see your machines" caption="Machines belong to your workspace." />
                    : paired.length === 0 && !index.loading
                        ? <EmptyState variant="machines" />
                        : null}
            </OpsPage>
        );
    };
});
