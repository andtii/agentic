import { component, signal, watch, type Define, type JSXElement } from 'sigx';
import { useRoute, useRouter } from '@sigx/router';
import type { EnvironmentDescriptor, EnvironmentInput, MachinePolicy } from '@agentic/core';
import { Button, ConfirmDialog, EmptyState, Icon, Label, StatusPill, TextField } from '@agentic/ui';
import { doctorChecks, doctorFootnote, environmentsOf, machinePolicyOf, opsMachine, queuedFor, sessionsOn, type DoctorCheck, type OpsMachine, type OpsSession } from '../mock/ops';
import { dataMode } from '../data-mode';
import { CommandWell } from './machines/CommandWell';
import { EnvironmentDialog } from './machines/EnvironmentDialog';
import { EnvironmentGrid, mockDefaultFor, type EnvironmentFacts } from './machines/MachineGroup';
import { machineHead } from './machines/head';
import { LiveMachine } from './machines/LiveMachine';
import { SessionsTable } from './machines/SessionsTable';
import type { DefaultForAgent } from './machines/live';
import { allowRootCommand, failureText, isWithin, loginCommand, needsLogin, policyState, rootsOf, runtimesOf, type EnvFailure } from './machines/manage';
import { LinkButton } from './ops/LinkButton';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar, routeId } from '../components/topbar';

/**
 * The page's last environment request (#239) as the container tracks it:
 * `pending` while the daemon has not answered, then `done` (the dialog
 * closes; the row arrives with the daemon's `env` frame) or `error`.
 * `seq` tells two requests with the same outcome apart.
 */
export interface EnvRequestState {
    readonly op: 'put' | 'remove';
    readonly environmentId?: string;
    readonly status: 'pending' | 'done' | 'error';
    readonly failure?: EnvFailure;
    readonly seq: number;
}

export type MachineViewProps =
    & Define.Prop<'machine', OpsMachine, true>
    & Define.Prop<'environments', readonly EnvironmentDescriptor[], true>
    & Define.Prop<'sessions', readonly OpsSession[], true>
    & Define.Prop<'doctor', readonly DoctorCheck[], true>
    & EnvironmentFacts
    /** Under the doctor checklist; the mock's Windows validation note unless given. */
    & Define.Prop<'footnote', string>
    /** The token is refused since this time (`Machine.revokedAt`): the revoke card says so instead of offering it again. */
    & Define.Prop<'revokedAt', number>
    /** Agent name and hue by id for the sessions table; the mock roster unless given. */
    & Define.Prop<'agents', (id: string) => DefaultForAgent>
    /** The confirmed revoke — the live page calls `Machine.revoke`. */
    & Define.Event<'revoke'>
    /** The doctor card's "Run again". */
    & Define.Event<'recheck'>
    /** What the machine's daemon last said about web management (`hello` / `env`, #237); absent → it reports none. */
    & Define.Prop<'policy', MachinePolicy>
    /** The runtimes the daemon can host, for a new environment. */
    & Define.Prop<'runtimes', readonly string[]>
    & Define.Prop<'envRequest', EnvRequestState | null>
    /** Add or change an environment (`Machine.putEnvironment`). */
    & Define.Event<'saveEnvironment', EnvironmentInput>
    /** Remove one (`Machine.removeEnvironment`). */
    & Define.Event<'removeEnvironment', string>
    & Define.Event<'rename', string>
    /** Revoke, then leave the workspace. */
    & Define.Event<'removeMachine'>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The first folder a machine's environments already work in: the likeliest one to allow. */
const likelyRoot = (environments: readonly EnvironmentDescriptor[]): string | undefined => environments.flatMap((e) => e.cwdRoots)[0];

/**
 * `/machines/:id` — the machine header, its environments as reported by
 * the daemon, the active sessions table, the EXE-07 doctor checklist and
 * the revoke card. Revoking says sessions become disconnected, not failed.
 *
 * Setting the machine up (#239): with web management on (the machine's own
 * `policy.json`), environments are added, changed and removed here and the
 * daemon writes them; off, the page shows the command that turns it on. A
 * signed-out account shows the command that signs it in — logins never
 * leave the machine. "This machine" renames it or removes it from the
 * workspace (revoked first).
 */
export const MachineView = component<MachineViewProps>(({ props, emit }) => {
    const ui = signal({ revoking: false, envOpen: false, editing: '', removing: '', removeOpen: false, renaming: false, name: '', renameAttempted: false, removingMachine: false });
    // A finished request closes the dialog it came from; a refusal keeps it open with the reason.
    watch(() => props.envRequest?.seq, () => {
        const r = props.envRequest;
        if (r?.status !== 'done') return;
        if (r.op === 'put') ui.envOpen = false;
        else ui.removeOpen = false;
    });
    const busy = (op: 'put' | 'remove'): boolean => props.envRequest?.op === op && props.envRequest.status === 'pending';
    const failure = (op: 'put' | 'remove'): EnvFailure | null => (props.envRequest?.op === op && props.envRequest.status === 'error' ? props.envRequest.failure ?? null : null);

    return () => {
        const m = props.machine;
        const active = props.sessions.length;
        const revoked = props.revokedAt !== undefined;
        const disconnected = active ? `${plural(active, 'session', 'sessions')} on this machine ${active === 1 ? 'becomes' : 'become'} disconnected, not failed, and can resume once the machine pairs again.` : 'No session is running on it.';
        const policy = policyState(props.policy);
        const manageable = policy === 'on' && !revoked;
        const offline = !m.online;
        const editing = props.environments.find((e) => e.id === ui.editing);
        const removing = props.environments.find((e) => e.id === ui.removing);
        const runtimes = props.runtimes ?? [];
        const actions = (env: EnvironmentDescriptor): JSXElement | null => {
            const login = needsLogin(env) && !revoked;
            if (!login && !manageable) return null;
            return (
                <>
                    {login ? (
                        <div data-env-login>
                            <span data-env-login-text>Sign {env.account.label} in on {m.name}:</span>
                            <CommandWell command={loginCommand(env.id)} />
                        </div>
                    ) : null}
                    {manageable ? (
                        <div data-env-actions>
                            <Button intent="default" disabled={offline} label={`Edit ${env.name}`} onClick={() => { ui.editing = env.id; ui.envOpen = true; }}>Edit</Button>
                            <Button intent="danger" disabled={offline} label={`Remove ${env.name}`} onClick={() => { ui.removing = env.id; ui.removeOpen = true; }}>Remove</Button>
                        </div>
                    ) : null}
                </>
            );
        };
        const removeSessions = removing ? props.sessions.filter((s) => s.environment === removing.name) : [];
        const removeQueued = removing ? props.queued[removing.id] ?? 0 : 0;
        const removeFailure = failure('remove');
        return (
            <OpsPage page="machine" title={m.name}>
                <header data-machine-hero data-machine={m.id} data-revoked={revoked ? '' : undefined}>
                    <span data-machine-glyph data-size="52" aria-hidden="true"><Icon name="machines" size={24} /></span>
                    <div data-machine-title>
                        <span data-machine-name data-size="lg">{m.name}</span>
                        <span data-machine-caption>{m.osLabel} · daemon {m.daemonVersion} · paired {m.pairedOn} · {m.online ? `heartbeat ${m.seen}` : `last seen ${m.seen}`}</span>
                    </div>
                    <StatusPill status={m.online ? 'online' : 'offline'} label={revoked ? 'REVOKED' : undefined} />
                </header>

                <section aria-label="Environments" data-machine-envs>
                    <div data-label-row>
                        <Label>Environments</Label>
                        {manageable
                            ? <Button intent="primary" disabled={offline} onClick={() => { ui.editing = ''; ui.envOpen = true; }}>Add environment</Button>
                            : <span data-label-aside>reported by the daemon</span>}
                    </div>
                    {manageable && offline ? <p data-env-note>The machine is offline. Environments can be changed while its daemon is connected.</p> : null}
                    {!revoked && policy !== 'on' ? (
                        <div data-card data-env-policy={policy}>
                            <p data-card-text>
                                {policy === 'unknown'
                                    ? `The daemon on ${m.name} does not say whether this page may manage its environments. Update agentic-daemon there, then allow the folder agents may work in:`
                                    : `${m.name} does not let this page manage its environments. To add them here, allow the folder agents may work in — on the machine:`}
                            </p>
                            <CommandWell command={allowRootCommand(likelyRoot(props.environments))} />
                            <p data-card-text>Only a command on the machine can widen what the web may reach. The page picks the change up when the daemon reports it.</p>
                        </div>
                    ) : null}
                    {props.environments.length
                        ? <EnvironmentGrid environments={props.environments} machine={m} queued={props.queued} defaultFor={props.defaultFor} actions={actions} />
                        : <EmptyState caption={m.online ? (manageable ? 'No environment yet. Add one to run agents on this machine.' : 'The daemon reported no environment.') : 'The daemon has not connected yet: its environments arrive with its first hello.'} />}
                </section>

                {manageable ? (<>
                <EnvironmentDialog
                    model={() => ui.envOpen}
                    {...(editing ? { environment: editing } : {})}
                    runtimes={runtimes}
                    {...(props.policy ? { policy: props.policy } : {})}
                    os={m.os}
                    takenNames={props.environments.filter((e) => e.id !== ui.editing).map((e) => e.name)}
                    busy={busy('put')}
                    failure={failure('put')}
                    onSave={(input: EnvironmentInput) => emit('saveEnvironment', input)}
                    onCancel={() => { ui.envOpen = false; }}
                />
                <ConfirmDialog
                    model={() => ui.removeOpen}
                    title={`Remove ${removing?.name ?? 'environment'}?`}
                    description={`The daemon forgets it on ${m.name}. Its profile directory and sign-in stay on the machine, and agents that default to it need another environment.`}
                    dependents={[...removeSessions.map((s) => `${s.id} · ${s.task}`), ...(removeQueued ? [`${plural(removeQueued, 'task', 'tasks')} queued`] : [])]}
                    dependentsLabel="Work in this environment — it has to finish first"
                    confirmLabel={`Remove ${removing?.name ?? 'environment'}`}
                    cancelLabel="Keep it"
                    busy={busy('remove')}
                    onConfirm={() => { if (removing) emit('removeEnvironment', removing.id); }}
                    onCancel={() => { ui.removeOpen = false; }}
                >
                    {removeFailure ? <p data-env-failure role="alert">{failureText(removeFailure)}</p> : null}
                </ConfirmDialog>
                </>) : null}

                <div data-machine-grid>
                    <section aria-label="Active sessions" data-machine-sessions>
                        <div data-label-row><Label>Active sessions</Label></div>
                        {active ? <SessionsTable sessions={props.sessions} agents={props.agents} /> : <EmptyState caption="No session is running on this machine." />}
                    </section>

                    <aside data-machine-rail>
                        <section data-card aria-label="Doctor">
                            <div data-label-row>
                                <Label>Doctor · account isolation</Label>
                                <Button intent="default" onClick={() => emit('recheck')}>Run again</Button>
                            </div>
                            <ul data-doctor-list>
                                {props.doctor.map(check => (
                                    <li data-doctor-check data-ok={check.ok ? '' : undefined}>
                                        <Icon name={check.ok ? 'check' : 'close'} size={15} label={check.ok ? 'passed' : 'failed'} />
                                        <span data-doctor-text>{check.text}</span>
                                        <span data-doctor-note>{check.note}</span>
                                    </li>
                                ))}
                            </ul>
                            <p data-doctor-foot>{props.footnote ?? doctorFootnote}</p>
                        </section>

                        <section data-card aria-label="This machine" data-machine-manage>
                            <div data-label-row><Label>This machine</Label></div>
                            <p data-card-text>Rename it, or remove it from this workspace. Removing revokes its token first; its environments and logins stay on the machine.</p>
                            <div data-card-actions>
                                <Button intent="default" onClick={() => { ui.name = m.name; ui.renameAttempted = false; ui.renaming = true; }}>Rename</Button>
                                <Button intent="danger" onClick={() => { ui.removingMachine = true; }}>Remove from workspace</Button>
                            </div>
                            <ConfirmDialog
                                model={() => ui.renaming}
                                title={`Rename ${m.name}`}
                                description="How the machine shows on every page. The daemon keeps its token."
                                confirmLabel="Rename"
                                danger={false}
                                onConfirm={() => {
                                    ui.renameAttempted = true;
                                    if (!ui.name.trim()) return;
                                    ui.renaming = false;
                                    if (ui.name.trim() !== m.name) emit('rename', ui.name.trim());
                                }}
                                onCancel={() => { ui.renaming = false; }}
                            >
                                <TextField model={() => ui.name} name="machine-name" label="Name" required error={ui.renameAttempted && !ui.name.trim() ? 'A name is required.' : undefined} />
                            </ConfirmDialog>
                            <ConfirmDialog
                                model={() => ui.removingMachine}
                                title={`Remove ${m.name} from this workspace?`}
                                description={`Its daemon token is revoked first, so it cannot connect again. ${revoked ? '' : disconnected} It leaves the Machines page; pairing it again brings it back. Credentials and environments stay on the machine.`}
                                dependents={props.sessions.map(s => `${s.id} · ${s.task}`)}
                                dependentsLabel={`Sessions that become disconnected · ${active}`}
                                confirmLabel={`Remove ${m.name}`}
                                cancelLabel="Keep it"
                                onCancel={() => { ui.removingMachine = false; }}
                                onConfirm={() => { ui.removingMachine = false; emit('removeMachine'); }}
                            />
                        </section>

                        <section data-card data-tone="failed" aria-label="Revoke">
                            <div data-label-row><Label>Revoke</Label></div>
                            {revoked ? (
                                <p data-card-text data-revoked-line>This machine is revoked: its daemon token is refused and it will not connect again until it pairs anew. Credentials stay on the machine.</p>
                            ) : (
                                <>
                                    <p data-card-text>The daemon token stops working at once. Sessions on this machine are marked disconnected, not failed. Credentials stay on the machine.</p>
                                    <ConfirmDialog
                                        model={() => ui.revoking}
                                        title={`Revoke ${m.name}?`}
                                        description={`The daemon token stops working at once. ${disconnected} Credentials stay on the machine.`}
                                        dependents={props.sessions.map(s => `${s.id} · ${s.task}`)}
                                        dependentsLabel={`Sessions that become disconnected · ${active}`}
                                        confirmLabel={active ? `Revoke and disconnect ${plural(active, 'session', 'sessions')}` : `Revoke ${m.name}`}
                                        cancelLabel="Keep paired"
                                        onCancel={() => { ui.revoking = false; }}
                                        onConfirm={() => { ui.revoking = false; emit('revoke'); }}
                                    />
                                    <div><Button intent="danger" onClick={() => { ui.revoking = true; }}>Revoke {m.name}</Button></div>
                                </>
                            )}
                        </section>
                    </aside>
                </div>
            </OpsPage>
        );
    };
});

defineTopbar('machine', (route) => {
    const id = routeId(route);
    // Live: what the page published for THIS machine (`machines/head.ts`); mock: the sample workspace.
    const m = dataMode() === 'live' ? (machineHead.value?.id === id ? machineHead.value : undefined) : opsMachine(id);
    return {
        crumb: m?.name,
        subtitle: m ? () => <span>{m.online ? `${m.osLabel} · heartbeat ${m.seen}` : `${m.osLabel} · last seen ${m.seen}`}</span> : undefined
    };
});

/** An environment id the way the mock names them (`env_alien01_work`). */
const mockEnvId = (machineId: string, name: string): string => `env_${machineId.replace(/-/g, '')}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

/**
 * The machine on mock data (`pnpm dev:mock`): the sample environments in
 * local state, and a daemon that answers at once under the fixture's policy
 * — the same folder rule the real one applies (#238), so every state of the
 * page can be walked through without a machine.
 */
const MockMachine = component<Define.Prop<'machine', OpsMachine, true>>(({ props }) => {
    const router = useRouter();
    const policy = machinePolicyOf(props.machine.id);
    const st = signal({ environments: [...environmentsOf(props.machine.id)], name: props.machine.name, request: null as EnvRequestState | null, seq: 0 });
    const answer = (r: Omit<EnvRequestState, 'seq'>): void => {
        st.seq += 1;
        st.request = { ...r, seq: st.seq };
    };
    const save = (input: EnvironmentInput): void => {
        const os = props.machine.os;
        const roots = rootsOf(input.cwdRoots.join('\n'));
        const outside = roots.find((r) => !(policy?.allowedRoots ?? []).some((a) => isWithin(r, a, os)));
        if (!policy?.webManaged) return answer({ op: 'put', status: 'error', failure: { code: 'policy-disabled', message: '' } });
        if (outside) return answer({ op: 'put', status: 'error', failure: { code: 'outside-allowed-roots', message: `${outside} is not inside ${policy.allowedRoots.join(', ')}.` } });
        const id = input.id ?? mockEnvId(props.machine.id, input.name);
        const was = st.environments.find((e) => e.id === id);
        const next: EnvironmentDescriptor = {
            id: id as EnvironmentDescriptor['id'],
            machineId: props.machine.id,
            name: input.name,
            runtime: input.runtime,
            account: { label: input.accountLabel ?? input.name, authStatus: was?.account.authStatus ?? 'missing' },
            cwdRoots: roots,
            concurrency: { active: was?.concurrency.active ?? 0, max: input.concurrency ?? was?.concurrency.max ?? 1 },
            isolation: 'config-dir'
        };
        st.environments = was ? st.environments.map((e) => (e.id === id ? next : e)) : [...st.environments, next];
        answer({ op: 'put', environmentId: id, status: 'done' });
    };
    const remove = (id: string): void => {
        const env = st.environments.find((e) => e.id === id);
        if (!env) return answer({ op: 'remove', environmentId: id, status: 'error', failure: { code: 'unknown-environment', message: '' } });
        if (sessionsOn(props.machine.id).some((s) => s.environment === env.name) || queuedFor[id]) return answer({ op: 'remove', environmentId: id, status: 'error', failure: { code: 'in-use', message: '' } });
        st.environments = st.environments.filter((e) => e.id !== id);
        answer({ op: 'remove', environmentId: id, status: 'done' });
    };
    return () => (
        <MachineView
            machine={{ ...props.machine, name: st.name }}
            environments={st.environments}
            sessions={sessionsOn(props.machine.id)}
            doctor={doctorChecks}
            queued={queuedFor}
            defaultFor={mockDefaultFor}
            {...(policy ? { policy } : {})}
            runtimes={runtimesOf([], st.environments)}
            envRequest={st.request}
            onSaveEnvironment={save}
            onRemoveEnvironment={remove}
            onRename={(name: string) => { st.name = name; }}
            onRemoveMachine={() => { void router.push('/machines'); }}
        />
    );
});

/** `/machines/:id` from the route param; a missing id gets the not-found card. */
export const Machine = component(() => {
    const route = useRoute();
    return () => {
        const id = String(route.params.id);
        if (dataMode() === 'live') return <LiveMachine id={id} />;
        const m = opsMachine(id);
        if (!m) {
            return (
                <OpsPage page="machine" title="Machine not found" hero>
                    <EmptyState title={`No machine with id ${id}`} caption="It may have been revoked, or the id is wrong." slots={{ actions: () => <LinkButton to="/machines">All machines</LinkButton> }} />
                </OpsPage>
            );
        }
        return <MockMachine machine={m} />;
    };
});
