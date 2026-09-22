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
 * resume shape — one Confirm click sends it. Revoke, Remove, the folders
 * card (`LivePolicyCard`, #482) and an environment save that turns
 * `bypassPermissions` on go through it; a Browse… that needed elevation
 * reopens the browser on the way back without a confirm (it changes nothing).
 *
 * Restart (#481): `Machine.requestRestart` from "This machine"; the pending
 * restart is read from `updateState` like an update, and its end is the
 * update card's "Restarted at …". The daemon log: `logTail` on opening the
 * disclosure and on Refresh, the answer read live with `logResult`.
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
import { MachineView, likelyRoot, type EnvRequestState, type RestartState } from '../Machine';
import { LinkButton } from '../ops/LinkButton';
import { OpsPage } from '../ops/OpsPage';
import { CLIENT_TIMEOUT_MS } from '../workdir/model';
import { machineHead } from './head';
import { LIVE_DOCTOR_FOOTNOTE, defaultForByEnvironment, doctorChecksOf, machineLoadOf, machineOf, queuedByEnvironment, sessionsOf } from './live';
import { answerFailure, callFailure, runtimesOf } from './manage';
import { browserPendingStore, elevateUrl, isElevationRequired, savePending, takePending, type PendingChange, type PendingKind } from './elevate';
import { ElevateDialog } from './ElevateDialog';
import { LiveHarnessCard } from './LiveHarnessCard';
import { LivePolicyCard, isPolicyPending, type PolicyPending } from './LivePolicyCard';
import { LiveUpdateCard } from './LiveUpdateCard';
import type { LogState } from './policy';

/** An environment draft as it comes back from the pending store: the shape `putEnvironment` takes, or nothing. */
const isEnvironmentInput = (v: unknown): v is EnvironmentInput => !!v && typeof v === 'object' && typeof (v as EnvironmentInput).name === 'string' && typeof (v as EnvironmentInput).runtime === 'string' && Array.isArray((v as EnvironmentInput).cwdRoots);

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
            // An elevation refusal is the helper's: the dialog stays as it was, the draft rides the round trip.
            if (isElevationRequired(e)) {
                settle({ ...scope, status: 'elevate' });
                throw e;
            }
            settle({ ...scope, status: 'error', failure: callFailure(e) });
        }
    };
    // Every save goes through the helper: only one that turns `bypassPermissions` on is refused without elevation (#480).
    const saveEnvironment = (input: EnvironmentInput): void => { void withElevation('environment', () => request('put', input.id, () => client().putEnvironment(input)), input); };
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
    const elevate = signal({ open: false, pending: null as PendingChange | null, resume: false, policyResume: null as PolicyPending | null });
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
            case 'policy':
                // The card sends it: a fresh object so its watch fires.
                if (isPolicyPending(change.draft)) elevate.policyResume = { allowedRoots: [...change.draft.allowedRoots] };
                return Promise.resolve();
            case 'environment':
                if (isEnvironmentInput(change.draft)) saveEnvironment(change.draft);
                return Promise.resolve();
            default:
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
    // Back from GitHub: the change waits for one click, never runs on its own — except a Browse…, which changes nothing and reopens where it was.
    onMounted(() => {
        const pending = takePending(browserPendingStore(), props.id);
        if (!pending) return;
        if (pending.kind === 'policy' && isPolicyPending(pending.draft) && pending.draft.browse !== undefined) {
            elevate.policyResume = { allowedRoots: [...pending.draft.allowedRoots], browse: pending.draft.browse };
            return;
        }
        elevate.pending = pending;
        elevate.resume = true;
        elevate.open = true;
    });

    // Restart (#481): asked from "This machine", followed on `updateState` like an update.
    const update = useActorState(defs.Machine, () => { const k = key(); return k && ([k, 'updateState'] as const); }, { live: true });
    const restart = signal({ error: '' });
    const requestRestart = async (mode: 'drain' | 'now'): Promise<void> => {
        restart.error = '';
        try {
            await client().requestRestart({ mode });
        } catch (e) {
            restart.error = e instanceof Error ? e.message : String(e);
        }
    };
    const restartState = (): RestartState | null => {
        if (restart.error) return { status: 'error', message: restart.error };
        const p = update.value?.pending;
        return p && p.target === 'restart' ? { status: 'pending', mode: p.mode } : null;
    };

    // The daemon log (#481): one request at a time, its answer read live like `envResult`.
    const log = signal({ requestId: '', state: null as LogState | null });
    let logTimer: ReturnType<typeof setTimeout> | undefined;
    onUnmounted(() => { if (logTimer !== undefined) clearTimeout(logTimer); });
    const logAnswer = useActorState(defs.Machine, () => { const k = key(); return k && log.requestId ? ([k, 'logResult', log.requestId] as const) : null; }, { live: true });
    const stopLog = effect(() => {
        const r = logAnswer.value;
        if (!r || r.requestId !== log.requestId || r.status === 'pending' || log.state?.status !== 'pending') return;
        if (logTimer !== undefined) clearTimeout(logTimer);
        log.state = r.status === 'done' && r.result
            ? { status: 'done', lines: r.result.lines, truncated: r.result.truncated }
            : { status: 'error', error: r.error ?? { code: 'internal', message: 'The machine answered with something else' } };
    });
    onUnmounted(stopLog);
    const readLog = async (): Promise<void> => {
        if (log.state?.status === 'pending') return;
        log.requestId = '';
        log.state = { status: 'pending' };
        try {
            const { requestId } = await client().logTail(200);
            log.requestId = requestId;
            if (logTimer !== undefined) clearTimeout(logTimer);
            logTimer = setTimeout(() => { if (log.state?.status === 'pending') log.state = { status: 'error', error: { code: 'timeout', message: '' } }; }, CLIENT_TIMEOUT_MS);
        } catch (e) {
            const status = (e as { status?: number } | null)?.status;
            const message = e instanceof Error ? e.message : String(e);
            log.state = { status: 'error', error: status === 503 ? { code: 'machine-offline', message } : status === 409 ? { code: 'unsupported', message } : { code: 'internal', message } };
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
                    {...(v.features ? { features: v.features } : {})}
                    runtimes={runtimesOf(v.capabilities, v.environments)}
                    envRequest={env.state}
                    onSaveEnvironment={saveEnvironment}
                    onRemoveEnvironment={removeEnvironment}
                    onRename={(name: string) => { void rename(name); }}
                    onRemoveMachine={() => { void removeMachine(); }}
                    {...(update.value ? { impact: update.value.impact } : {})}
                    restartState={restartState()}
                    onRestart={(mode: 'drain' | 'now') => { void requestRestart(mode); }}
                    log={log.state}
                    onReadLog={() => { void readLog(); }}
                    slots={{
                        policy: () => (v.revoked ? null : (
                            <LivePolicyCard
                                machineKey={key()!}
                                view={v}
                                name={v.name || id}
                                os={v.os ?? 'linux'}
                                likelyRoot={likelyRoot(v.environments) ?? ''}
                                elevate={(run, draft) => withElevation('policy', run, draft)}
                                resume={elevate.policyResume}
                            />
                        )),
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
