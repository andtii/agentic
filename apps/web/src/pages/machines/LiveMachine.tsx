/**
 * `/machines/:id` on the platform (#144): the Machine actor read live
 * (`get`: online, last seen, environments, hosted and queued sessions),
 * its doctor verdicts (`doctor`, re-read whenever the record changes and
 * on "Run again"), each hosted session's task objective (`Task.get`), the
 * router's parked tasks and the directory's agents — folded into the same
 * `MachineView` the mock page renders. Revoke is `Machine.revoke`: the
 * token is refused from then on and the page says so.
 *
 * Setting the machine up (#239): an environment is added, changed or
 * removed with `Machine.putEnvironment` / `removeEnvironment`, and the
 * daemon's answer is read live with `envResult(requestId)` — the round trip
 * the folder picker makes with `fsRequest` / `fsResult`. The new row itself
 * arrives with the daemon's `env` frame on `get`. Rename is `Machine.rename`;
 * removing the machine revokes it first, then drops it from the Workspace
 * index (`removeMachine` alone leaves the token valid, #259).
 *
 * Runtimes (#370): "Runtimes on this machine" (`LiveHarnessCard`) reads the
 * same live `get` — the daemon's harnesses, what the release ships — and
 * installs, updates or removes one with `Machine.requestHarness`.
 *
 * Elevation (#355): a call the platform refuses `elevation-required` opens
 * "Confirm with GitHub to continue" (`ElevateDialog`); the change is put
 * aside per machine (`savePending`) for the round trip through
 * `/auth/elevate`, and on the way back the page reopens the dialog in its
 * resume shape — one Confirm click sends it. Revoke and Remove go through it;
 * the folders card and the bypass switch (#482) will too.
 */
import { component, effect, onMounted, onUnmounted, signal, useData, type JSXElement } from 'sigx';
import { useRouter } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { EnvironmentId, EnvironmentInput, MachineId } from '@agentic/core';
import { EmptyState } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, routingKeyOf, taskKeyOf, workspaceKeyOf } from '../../actors/keys';
import { useAgentDirectory } from '../chat/directory';
import { MachineView, type EnvRequestState } from '../Machine';
import { LinkButton } from '../ops/LinkButton';
import { OpsPage } from '../ops/OpsPage';
import { CLIENT_TIMEOUT_MS } from '../workdir/model';
import { machineHead } from './head';
import { LIVE_DOCTOR_FOOTNOTE, defaultForByEnvironment, doctorChecksOf, machineLoadOf, machineOf, queuedByEnvironment, sessionsOf } from './live';
import { answerFailure, callFailure, runtimesOf } from './manage';
import { browserPendingStore, elevateUrl, isElevationRequired, savePending, takePending, type PendingChange, type PendingKind } from './elevate';
import { ElevateDialog } from './ElevateDialog';
import { LiveHarnessCard } from './LiveHarnessCard';
import { LiveUpdateCard } from './LiveUpdateCard';

export const LiveMachine = component<{ id: string }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const router = useRouter();
    const directory = useAgentDirectory(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? machineKeyOf(viewer.workspaceId, props.id) : null);
    const client = () => actor(defs.Machine, key()!);

    // The page's one environment request at a time: its id, then the daemon's answer read live.
    const env = signal({ requestId: '', state: null as EnvRequestState | null, seq: 0 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    onUnmounted(clearTimer);
    const settle = (next: Omit<EnvRequestState, 'seq'>): void => {
        env.seq += 1;
        env.state = { ...next, seq: env.seq };
    };
    const answer = useActorState(defs.Machine, () => { const k = key(); return k && env.requestId ? ([k, 'envResult', env.requestId] as const) : null; }, { live: true });
    const stopAnswer = effect(() => {
        const r = answer.value;
        const s = env.state;
        if (!r || r.requestId !== env.requestId || r.status === 'pending' || s?.status !== 'pending') return;
        clearTimer();
        settle(r.status === 'done'
            ? { op: s.op, ...(s.environmentId ? { environmentId: s.environmentId } : {}), status: 'done' }
            : { op: s.op, ...(s.environmentId ? { environmentId: s.environmentId } : {}), status: 'error', failure: r.error ? answerFailure(r.error) : { code: 'internal', message: 'The machine answered with something else' } });
    });
    onUnmounted(stopAnswer);
    const request = async (op: 'put' | 'remove', environmentId: string | undefined, send: () => Promise<{ requestId: string }>): Promise<void> => {
        if (env.state?.status === 'pending') return;
        const scope = { op, ...(environmentId ? { environmentId } : {}) };
        // Forget the last answer first: it is still `done` under the old id and must not settle this request.
        env.requestId = '';
        settle({ ...scope, status: 'pending' });
        try {
            const { requestId } = await send();
            env.requestId = requestId;
            clearTimer();
            // The platform fails an unanswered request itself (`timeout`), on its liveness tick; the page need not wait that long to say so.
            timer = setTimeout(() => { if (env.state?.status === 'pending') settle({ ...scope, status: 'error', failure: { code: 'timeout', message: '' } }); }, CLIENT_TIMEOUT_MS);
        } catch (e) {
            settle({ ...scope, status: 'error', failure: callFailure(e) });
        }
    };
    const saveEnvironment = (input: EnvironmentInput): void => { void request('put', input.id, () => client().putEnvironment(input)); };
    const removeEnvironment = (id: string): void => { void request('remove', id, () => client().removeEnvironment(id as EnvironmentId)); };

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
    /** One owner action at a time; a failure is the line under the page. */
    const act = async (run: () => Promise<unknown>): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await run();
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    /**
     * Elevation (#355): `open` is the dialog's state — `pending` what was being done, `resume` whether the round trip is
     * done. `withElevation` runs a change and, refused `elevation-required`, asks instead of failing; `dispatch` runs a
     * change by kind, which is what the resumed dialog's Confirm does.
     */
    const elevate = signal({ open: false, pending: null as PendingChange | null, resume: false });
    const withElevation = async (kind: PendingKind, run: () => Promise<unknown>, draft?: unknown): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await run();
        } catch (e) {
            if (isElevationRequired(e)) {
                elevate.pending = { kind, ...(draft === undefined ? {} : { draft }), at: Date.now() };
                elevate.resume = false;
                elevate.open = true;
            } else st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    const revoke = (): Promise<void> => withElevation('revoke', () => client().revoke());
    const rename = (name: string): Promise<void> => act(() => client().rename(name));
    // Revoke FIRST: `Workspace.removeMachine` only drops the index entry, and a daemon still holding a valid token could reconnect (#259).
    const removeMachine = (): Promise<void> =>
        withElevation('remove', async () => {
            const ws = viewer.workspaceId;
            if (!ws) return;
            await client().revoke();
            await actor(defs.Workspace, workspaceKeyOf(ws)).removeMachine(props.id as MachineId);
            await router.push('/machines');
        });
    const dispatch = (change: PendingChange): Promise<void> => {
        switch (change.kind) {
            case 'revoke':
                return revoke();
            case 'remove':
                return removeMachine();
            default:
                // `policy` / `environment` arrive with their cards (#482).
                return Promise.resolve();
        }
    };
    /** Continue: keep the change for the way back, then GitHub. Runs only in a browser — the page's own URL is the way back. */
    const toGitHub = (): void => {
        const pending = elevate.pending;
        if (!pending) return;
        savePending(browserPendingStore(), props.id, { kind: pending.kind, ...(pending.draft === undefined ? {} : { draft: pending.draft }) });
        elevate.open = false;
        if (typeof location !== 'undefined') location.assign(elevateUrl(`${location.pathname}${location.search}${location.hash}`));
    };
    // Back from GitHub: the change waits for one click, never runs on its own.
    onMounted(() => {
        const pending = takePending(browserPendingStore(), props.id);
        if (pending) {
            elevate.pending = pending;
            elevate.resume = true;
            elevate.open = true;
        }
    });

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
        const now = Date.now();
        return (
            <>
                <MachineView
                    machine={machineOf(v, id, now)}
                    environments={v.environments}
                    sessions={sessionsOf(v, objectives.value ?? {}, now)}
                    doctor={doctor.value ? doctorChecksOf(doctor.value) : []}
                    footnote={LIVE_DOCTOR_FOOTNOTE}
                    queued={queuedByEnvironment(routing.value ?? undefined, v.machineId)}
                    defaultFor={defaultForByEnvironment(agents, v.environments)}
                    quota={v.quota ?? {}}
                    {...(v.telemetry ? { load: v.telemetry.environments, machineLoad: machineLoadOf(v.telemetry, now) } : {})}
                    revokedAt={v.revokedAt}
                    agents={(agentId) => { const a = directory.lookup(agentId); return { name: a.name, hue: a.hue }; }}
                    onRevoke={() => { void revoke(); }}
                    onRecheck={() => { void doctor.refresh(); }}
                    {...(v.policy ? { policy: v.policy } : {})}
                    runtimes={runtimesOf(v.capabilities, v.environments)}
                    envRequest={env.state}
                    onSaveEnvironment={saveEnvironment}
                    onRemoveEnvironment={removeEnvironment}
                    onRename={(name: string) => { void rename(name); }}
                    onRemoveMachine={() => { void removeMachine(); }}
                    slots={{
                        update: () => (v.revoked ? null : (
                            <LiveUpdateCard
                                machineKey={key()!}
                                name={v.name || id}
                                os={v.os ?? 'linux'}
                                daemonVersion={v.daemonVersion}
                                turnLabel={(t) => `${directory.lookup(t.agentId).name} · ${t.sessionId}`}
                            />
                        )),
                        harness: () => (v.revoked ? null : (
                            <LiveHarnessCard
                                machineKey={key()!}
                                view={v}
                                name={v.name || id}
                                os={v.os ?? 'linux'}
                                turnLabel={(t) => `${directory.lookup(t.agentId).name} · ${t.sessionId}`}
                            />
                        ))
                    }}
                />
                {st.error ? <p data-machine-error role="alert">{st.error}</p> : null}
                {elevate.pending ? (
                    <ElevateDialog
                        model={() => elevate.open}
                        kind={elevate.pending.kind}
                        machineName={v.name || id}
                        resume={elevate.resume}
                        busy={st.busy}
                        onContinue={toGitHub}
                        onConfirm={() => { const pending = elevate.pending; elevate.open = false; if (pending) void dispatch(pending); }}
                        onCancel={() => { elevate.open = false; elevate.pending = null; }}
                    />
                ) : null}
            </>
        );
    };
});
