/**
 * `/machines/:id` on the platform (#144): the Machine actor read live
 * (`get`: online, last seen, environments, hosted and queued sessions),
 * its doctor verdicts (`doctor`, re-read whenever the record changes and
 * on "Run again"), each hosted session's task objective (`Task.get`), the
 * router's parked tasks and the directory's agents — folded into the same
 * `MachineView` the mock page renders. Revoke is `Machine.revoke`: the
 * token is refused from then on and the page says so.
 */
import { component, effect, onUnmounted, signal, useData, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, routingKeyOf, taskKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { MachineView } from '../Machine';
import { LinkButton } from '../ops/LinkButton';
import { OpsPage } from '../ops/OpsPage';
import { machineHead } from './head';
import { LIVE_DOCTOR_FOOTNOTE, defaultForByEnvironment, doctorChecksOf, machineOf, queuedByEnvironment, sessionsOf } from './live';

export const LiveMachine = component<{ id: string }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? machineKeyOf(viewer.workspaceId, props.id) : null);
    const client = () => actor(defs.Machine, key()!);

    const view = useActorState(defs.Machine, () => { const k = key(); return k && ([k, 'get'] as const); }, { live: true });
    const doctor = useActorState(defs.Machine, () => { const k = key(); return k && ([k, 'doctor'] as const); }, { live: true });
    const routing = useActorState(defs.Routing, () => { const ws = viewer.workspaceId; return ws && ([routingKeyOf(ws), 'get'] as const); }, { live: true });
    // The objectives of the tasks the hosted sessions run, keyed by the task ids so a new session re-reads.
    const objectives = useData(
        () => {
            const ws = viewer.workspaceId;
            const ids = view.value?.activeSessions.map((h) => h.taskId).filter((t): t is NonNullable<typeof t> => !!t) ?? [];
            return ws ? (['machine-tasks', ws, ...ids] as const) : false;
        },
        async (k): Promise<Record<string, string>> => {
            const [, ws, ...ids] = k as readonly [string, string, ...string[]];
            const out: Record<string, string> = {};
            await Promise.all(ids.map(async (id) => {
                try {
                    out[id] = (await actor(defs.TaskActor, taskKeyOf(ws, id)).get()).objective;
                } catch {
                    // Gone or not ours to read: the row shows the id.
                }
            }));
            return out;
        }
    );

    const st = signal({ busy: false, error: '' });
    const revoke = async (): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await client().revoke();
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };

    const stopHead = effect(() => {
        const v = view.value;
        machineHead.value = v ? machineOf(v, props.id, Date.now()) : null;
    });
    onUnmounted(stopHead);

    return (): JSXElement => {
        const v = view.value;
        const id = props.id;
        if (view.state === 'errored' || (!viewer.pending && !viewer.workspaceId)) {
            return (
                <OpsPage page="machine" title="Machine not found" hero>
                    <EmptyState
                        title={viewer.workspaceId ? `No machine with id ${id}` : 'Sign in to see your machines'}
                        caption={viewer.workspaceId ? (view.error?.message ?? 'It may have been revoked, or the id is wrong.') : 'Machines belong to your workspace.'}
                        slots={{ actions: () => <LinkButton to="/machines">All machines</LinkButton> }}
                    />
                </OpsPage>
            );
        }
        if (!v) return <section data-page="machine" data-machine={id} aria-busy="true" />;
        // An unknown id activates an empty record: never paired, nothing to show.
        if (!v.paired) {
            return (
                <OpsPage page="machine" title="Machine not paired" hero>
                    <EmptyState title={`No paired machine with id ${id}`} caption="Either the id is wrong, or the daemon has not redeemed its pairing code yet." slots={{ actions: () => <LinkButton to="/machines">All machines</LinkButton> }} />
                </OpsPage>
            );
        }
        const agents = directory.all();
        return (
            <>
                <MachineView
                    machine={machineOf(v, id, Date.now())}
                    environments={v.environments}
                    sessions={sessionsOf(v, objectives.value ?? {})}
                    doctor={doctor.value ? doctorChecksOf(doctor.value) : []}
                    footnote={LIVE_DOCTOR_FOOTNOTE}
                    queued={queuedByEnvironment(routing.value ?? undefined, v.machineId)}
                    defaultFor={defaultForByEnvironment(agents)}
                    revokedAt={v.revokedAt}
                    agents={(agentId) => { const a = directory.lookup(agentId); return { name: a.name, hue: a.hue }; }}
                    onRevoke={() => { void revoke(); }}
                    onRecheck={() => { void doctor.refresh(); }}
                />
                {st.error ? <p data-machine-error role="alert">{st.error}</p> : null}
            </>
        );
    };
});
