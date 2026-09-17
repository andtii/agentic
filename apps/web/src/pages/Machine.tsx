import { component, signal, type Define } from 'sigx';
import { useRoute } from '@sigx/router';
import type { EnvironmentDescriptor } from '@agentic/core';
import { Button, ConfirmDialog, EmptyState, Icon, Label, StatusPill } from '@agentic/ui';
import { doctorChecks, doctorFootnote, environmentsOf, opsMachine, sessionsOn, type DoctorCheck, type OpsMachine, type OpsSession } from '../mock/ops';
import { EnvironmentGrid } from './machines/MachineGroup';
import { SessionsTable } from './machines/SessionsTable';
import { LinkButton } from './ops/LinkButton';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar, routeId } from '../components/topbar';

export type MachineViewProps =
    & Define.Prop<'machine', OpsMachine, true>
    & Define.Prop<'environments', readonly EnvironmentDescriptor[], true>
    & Define.Prop<'sessions', readonly OpsSession[], true>
    & Define.Prop<'doctor', readonly DoctorCheck[], true>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * `/machines/:id` — the machine header, its environments as reported by
 * the daemon, the active sessions table, the EXE-07 doctor checklist and
 * the revoke card. Revoking says sessions become disconnected, not failed.
 */
export const MachineView = component<MachineViewProps>(({ props }) => {
    const ui = signal({ revoking: false });
    return () => {
        const m = props.machine;
        const active = props.sessions.length;
        const disconnected = active ? `${plural(active, 'session', 'sessions')} on this machine ${active === 1 ? 'becomes' : 'become'} disconnected, not failed, and can resume once the machine pairs again.` : 'No session is running on it.';
        return (
            <OpsPage page="machine" title={m.name}>
                <header data-machine-hero>
                    <span data-machine-glyph data-size="52" aria-hidden="true"><Icon name="machines" size={24} /></span>
                    <div data-machine-title>
                        <span data-machine-name data-size="lg">{m.name}</span>
                        <span data-machine-caption>{m.osLabel} · daemon {m.daemonVersion} · paired {m.pairedOn} · {m.online ? `heartbeat ${m.seen}` : `last seen ${m.seen}`}</span>
                    </div>
                    <StatusPill status={m.online ? 'online' : 'offline'} />
                </header>

                <section aria-label="Environments" data-machine-envs>
                    <div data-label-row>
                        <Label>Environments</Label>
                        <span data-label-aside>reported by the daemon</span>
                    </div>
                    <EnvironmentGrid environments={props.environments} machine={m} />
                </section>

                <div data-machine-grid>
                    <section aria-label="Active sessions" data-machine-sessions>
                        <div data-label-row><Label>Active sessions</Label></div>
                        {active ? <SessionsTable sessions={props.sessions} /> : <EmptyState caption="No session is running on this machine." />}
                    </section>

                    <aside data-machine-rail>
                        <section data-card aria-label="Doctor">
                            <div data-label-row>
                                <Label>Doctor · account isolation</Label>
                                <Button intent="default">Run again</Button>
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
                            <p data-doctor-foot>{doctorFootnote}</p>
                        </section>

                        <section data-card data-tone="failed" aria-label="Revoke">
                            <div data-label-row><Label>Revoke</Label></div>
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
                                onConfirm={() => { ui.revoking = false; }}
                            />
                            <div><Button intent="danger" onClick={() => { ui.revoking = true; }}>Revoke {m.name}</Button></div>
                        </section>
                    </aside>
                </div>
            </OpsPage>
        );
    };
});

defineTopbar('machine', (route) => {
    const m = opsMachine(routeId(route));
    return {
        crumb: m?.name,
        subtitle: m ? () => <span>{m.online ? `${m.osLabel} · heartbeat ${m.seen}` : `${m.osLabel} · last seen ${m.seen}`}</span> : undefined
    };
});

/** `/machines/:id` from the route param; a missing id gets the not-found card. */
export const Machine = component(() => {
    const route = useRoute();
    return () => {
        const id = String(route.params.id);
        const m = opsMachine(id);
        if (!m) {
            return (
                <OpsPage page="machine" title="Machine not found" hero>
                    <EmptyState title={`No machine with id ${id}`} caption="It may have been revoked, or the id is wrong." slots={{ actions: () => <LinkButton to="/machines">All machines</LinkButton> }} />
                </OpsPage>
            );
        }
        return <MachineView machine={m} environments={environmentsOf(m.id)} sessions={sessionsOn(m.id)} doctor={doctorChecks} />;
    };
});
