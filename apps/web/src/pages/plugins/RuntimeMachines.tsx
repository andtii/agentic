/**
 * A harness runtime's "Machines" section on `/plugins/<runtime>` (#370;
 * PLG-02, PLG-09): every paired machine, and whether it has the runtime's
 * harness (at which version, with a newer one waiting), lacks it, or has a
 * broken one — each linking to that machine's "Runtimes on this machine"
 * card, where it is installed, updated or removed — and, once installed, to
 * its environments, where one on the runtime is added and signed in (#527).
 * The live section reads
 * the Workspace's machine index and each machine's `get` live, both from
 * the app stores (#1120).
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { Card } from '@sigx/zero';
import { Label, StatusPill, type Tone } from '@agentic/ui';
import { useMachineStore, useWorkspaceStore } from '@agentic/client';
import { useViewer } from '../../actors/defs';
import { RUNTIME_MACHINE_TEXT, runtimeMachineLine, runtimeOnMachine, type RuntimeMachine } from '../machines/harness';

const TONE: Readonly<Record<RuntimeMachine['state'], Tone>> = { has: 'live', lacks: 'muted', broken: 'failed', unknown: 'muted' };

/** One machine's line: its name (to its runtimes card), where the runtime stands there, and whether it is online. */
export const RuntimeMachineRow = component<Define.Prop<'machine', RuntimeMachine, true>>(({ props }) => () => {
    const m = props.machine;
    return (
        <li data-runtime-machine={m.machineId} data-state={m.state}>
            <Link to={`/machines/${m.machineId}#runtimes`} class="ag-ref">{m.name}</Link>
            <StatusPill status={m.state} label={RUNTIME_MACHINE_TEXT[m.state].toUpperCase()} tone={TONE[m.state]} />
            <span data-runtime-machine-version>{runtimeMachineLine(m)}</span>
            {/* A newer build waits: the update itself (drain or now) is on the machine's runtimes card (#600). */}
            {m.update ? <span data-runtime-machine-update><Link to={`/machines/${m.machineId}#runtimes`} class="ag-ref">Update</Link></span> : null}
            {/* Installed: what makes the runtime usable is an environment on it, signed in (#527). */}
            {m.state === 'has' ? <span data-runtime-machine-env><Link to={`/machines/${m.machineId}#environments`} class="ag-ref">Add an environment</Link></span> : null}
        </li>
    );
});

/** The section's frame: its heading and the list, or what to do when no machine is paired. */
export const RuntimeMachines = component<Define.Prop<'name', string, true> & Define.Prop<'empty', boolean> & Define.Slot<'default'>>(({ props, slots }) => () => (
    <Card.Root asChild>
        {(card) => (
            <section {...card} data-runtime-machines aria-label="Machines">
                <Card.Header>
                    <div data-label-row><Card.Title><Label>Machines</Label></Card.Title><span data-label-aside>where {props.name} is installed</span></div>
                </Card.Header>
                <Card.Body data-card-body="">
                    {props.empty
                        ? <p data-card-text>No machine is paired yet. Pair one from the Machines page; {props.name} is installed on it from its page.</p>
                        : <>
                            <p data-card-text>Install {props.name} on a machine, add an environment that runs on it, then sign that environment in.</p>
                            <ul data-runtime-machine-list>{slots.default?.()}</ul>
                        </>}
                </Card.Body>
            </section>
        )}
    </Card.Root>
));

const LiveRuntimeMachine = component<{ runtime: string; id: string; name: string }>(({ props }) => {
    const store = useMachineStore();
    return (): JSXElement | null => {
        const v = store.machine(props.id);
        if (!v || v.revoked) return null;
        return <RuntimeMachineRow machine={runtimeOnMachine(props.runtime, { machineId: props.id, name: v.name || props.name, online: v.online, ...(v.harnesses ? { harnesses: v.harnesses } : {}), ...(v.harnessesAvailable ? { harnessesAvailable: v.harnessesAvailable } : {}) })} />;
    };
});

/** The section on the platform: the paired machines, each read live. */
export const LiveRuntimeMachines = component<Define.Prop<'runtime', string, true> & Define.Prop<'name', string, true>>(({ props }) => {
    const viewer = useViewer()();
    const index = useWorkspaceStore().machinesRead;
    return (): JSXElement | null => {
        const ws = viewer.workspaceId;
        if (!ws || !index.value) return null;
        const paired = index.value.filter((m) => m.status === 'paired');
        return (
            <RuntimeMachines name={props.name} empty={paired.length === 0}>
                {paired.map((m) => <LiveRuntimeMachine runtime={props.runtime} id={m.id} name={m.name} />)}
            </RuntimeMachines>
        );
    };
});
