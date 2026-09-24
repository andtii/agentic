import { component, signal, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { Card } from '@sigx/zero';
import type { HostOs } from '@agentic/core';
import type { HarnessResultView } from '@agentic/platform';
import { Button, ConfirmDialog, ErrorNote, Label, SelectField, StatusPill, type Tone } from '@agentic/ui';
import { CommandWell } from './CommandWell';
import { PhaseTimeline } from './PhaseTimeline';
import { harnessImpactText, harnessSteps, outcomeLine, pendingLine, removeBlocked, versionLine, type HarnessRow, type HarnessTurn } from './harness';
import { reinstallCommand } from './update';

/** What the owner asks of one runtime. */
export interface HarnessAsk {
    readonly op: 'install' | 'update' | 'remove';
    readonly runtime: string;
    readonly mode: 'drain' | 'now';
}

export type HarnessCardProps =
    & Define.Prop<'rows', readonly HarnessRow[], true>
    & Define.Prop<'name', string, true>
    & Define.Prop<'os', HostOs, true>
    /** The platform origin the reinstall line points at. */
    & Define.Prop<'origin', string, true>
    & Define.Prop<'online', boolean, true>
    /** The daemon answers `harness` (`hello.features`); without it the card shows the reinstall line. */
    & Define.Prop<'able', boolean, true>
    /** The request the card follows: in flight (phases), or just finished (its outcome). */
    & Define.Prop<'current', HarnessResultView | null>
    /** A call is on its way (the buttons wait). */
    & Define.Prop<'busy', boolean>
    /** Why the last ask was refused, on the runtime's row. */
    & Define.Prop<'failure', { readonly runtime: string; readonly text: string } | null>
    /** `requestHarness` said "reinstall once": the installer line shows. */
    & Define.Prop<'reinstall', boolean>
    & Define.Prop<'turnLabel', (turn: HarnessTurn) => string>
    & Define.Event<'request', HarnessAsk>
    /** Below the card's own content: the mock's state picker. */
    & Define.Slot<'default'>;

const STATUS: Readonly<Record<HarnessRow['status'], { readonly label: string; readonly tone: Tone }>> = {
    ready: { label: 'READY', tone: 'live' },
    missing: { label: 'NOT INSTALLED', tone: 'muted' },
    broken: { label: 'BROKEN', tone: 'failed' }
};

const turnHref = (t: HarnessTurn): string => (t.taskId ? `/tasks/${t.taskId}` : `/sessions/${t.sessionId}`);

/**
 * "Runtimes on this machine" (#370; EXE-08, AGT-09, PLG-02, PLG-09): each
 * harness runtime the daemon reports — installed version or "not
 * installed", the version the release ships, ready / missing / broken, the
 * environments that run on it — with **Install**, **Update** (a confirm
 * naming what it interrupts on that runtime, and the drain / now choice)
 * and **Remove** (off, with the reason, while an environment uses it). A
 * request's phases follow the daemon live; only that runtime drains. A
 * daemon that does not manage harnesses gets the installer line to run once.
 */
export const HarnessCard = component<HarnessCardProps>(({ props, emit, slots }) => {
    const ui = signal({ updating: '', removing: '', mode: 'drain' });
    const row = (runtime: string): HarnessRow | undefined => props.rows.find((r) => r.runtime === runtime);
    const turnLinks = (turns: readonly HarnessTurn[]): JSXElement => (
        <ul data-update-turns>
            {turns.map((t) => (
                <li data-update-turn={t.sessionId}><Link to={turnHref(t)} class="ag-ref">{props.turnLabel ? props.turnLabel(t) : `${t.agentId} · ${t.sessionId}`}</Link></li>
            ))}
        </ul>
    );

    return () => {
        const request = props.current ?? null;
        const pending = request?.status === 'pending' ? request : null;
        const busy = !!props.busy;
        const blocked = busy || !props.online || pending !== null;
        const updating = row(ui.updating);
        const removing = row(ui.removing);
        const mode = ui.mode === 'now' ? 'now' : 'drain';
        return (
            <Card.Root asChild>
            {(card) => (
            <section {...card} data-harness-card id="runtimes" aria-label="Runtimes on this machine">
                <Card.Header>
                    <div data-label-row>
                        <Card.Title><Label>Runtimes on this machine</Label></Card.Title>
                        {props.able && props.rows.some((r) => r.update) ? <span data-label-aside>{props.rows.filter((r) => r.update).length} with an update</span> : null}
                    </div>
                </Card.Header>
                <Card.Body data-card-body="">

                {!props.able ? (
                    <div data-update-reinstall>
                        <p data-card-text>This daemon does not manage its runtimes — reinstall once with the one-line installer on {props.name}:</p>
                        <CommandWell command={reinstallCommand(props.origin, props.os)} />
                        <p data-card-text>It upgrades in place: the machine stays paired, its environments and sign-ins stay. From then on its runtimes are installed and updated from this page.</p>
                    </div>
                ) : null}
                {props.able && !props.online ? <p data-env-note>The machine is offline. Its runtimes can be changed while its daemon is connected.</p> : null}
                {props.able && props.rows.length === 0 ? <p data-card-text>The daemon reported no runtime.</p> : null}

                {props.able && props.rows.length ? (
                    <ul data-harness-list>
                        {props.rows.map((r) => {
                            const mine = request?.runtime === r.runtime ? request : null;
                            const outcome = mine ? outcomeLine(mine) : null;
                            const failure = props.failure?.runtime === r.runtime ? props.failure.text : null;
                            const reason = removeBlocked(r);
                            const canInstall = (r.installed === undefined || r.status === 'broken') && r.installable;
                            const canRemove = r.installed !== undefined || r.status === 'broken';
                            return (
                                <li data-harness-row={r.runtime} data-status={r.status}>
                                    <div data-harness-head>
                                        <span data-harness-name>{r.name}</span>
                                        <StatusPill status={r.status} label={STATUS[r.status].label} tone={STATUS[r.status].tone} />
                                        {r.update ? <StatusPill status="available" label="UPDATE" tone="needs-you" /> : null}
                                    </div>
                                    <p data-harness-version>{versionLine(r)}</p>
                                    <p data-harness-envs>{r.environments.length ? `Used by ${r.environments.join(', ')}` : 'No environment runs on it.'}</p>
                                    {mine?.status === 'pending' ? (
                                        <div data-harness-pending>
                                            <p data-card-text>{pendingLine(mine)}</p>
                                            <PhaseTimeline
                                                steps={harnessSteps(mine)}
                                                label={`${r.name}: phases`}
                                                detail={(s) => (s.phase === 'draining' && s.state === 'current' && r.running.length ? (
                                                    <div data-update-draining>
                                                        <span>Waiting for {r.running.length === 1 ? 'a running turn' : `${r.running.length} running turns`} on {r.name}:</span>
                                                        {turnLinks(r.running)}
                                                    </div>
                                                ) : null)}
                                            />
                                        </div>
                                    ) : null}
                                    {outcome
                                        ? mine?.status === 'error'
                                            ? <ErrorNote data-harness-outcome="" data-tone="failed">{outcome}</ErrorNote>
                                            : <p data-harness-outcome role="status">{outcome}</p>
                                        : null}
                                    {failure ? <ErrorNote data-harness-error="">{failure}</ErrorNote> : null}
                                    <div data-card-actions>
                                        {canInstall ? <Button intent="primary" loading={busy} disabled={blocked} label={`Install ${r.name}`} onClick={() => emit('request', { op: 'install', runtime: r.runtime, mode: 'drain' })}>{r.status === 'broken' ? 'Reinstall' : 'Install'}</Button> : null}
                                        {r.update ? <Button intent="primary" disabled={blocked} label={`Update ${r.name}`} onClick={() => { ui.mode = 'drain'; ui.updating = r.runtime; }}>Update…</Button> : null}
                                        {canRemove ? <Button intent="default" disabled={blocked || reason !== null} label={`Remove ${r.name}`} onClick={() => { ui.removing = r.runtime; }}>Remove…</Button> : null}
                                    </div>
                                    {canRemove && reason ? <p data-harness-remove-reason>{reason}</p> : null}
                                </li>
                            );
                        })}
                    </ul>
                ) : null}

                {props.reinstall && props.able ? <ErrorNote data-harness-error="">The daemon said it cannot manage its runtimes. Reinstall it once with the one-line installer.</ErrorNote> : null}
                {slots.default?.()}
                </Card.Body>

                <ConfirmDialog
                    model={() => ui.updating !== ''}
                    title={`Update ${updating?.name ?? 'the runtime'} on ${props.name}${updating?.available ? ` to ${updating.available}` : ''}?`}
                    description={updating ? harnessImpactText(updating, mode) : ''}
                    confirmLabel={mode === 'now' && updating?.running.length ? `Interrupt ${updating.running.length} and update` : 'Update'}
                    cancelLabel="Not now"
                    danger={mode === 'now' && !!updating?.running.length}
                    onCancel={() => { ui.updating = ''; }}
                    onConfirm={() => { const r = updating; ui.updating = ''; if (r) emit('request', { op: 'update', runtime: r.runtime, mode }); }}
                >
                    <div data-harness-confirm>
                        <SelectField
                            name="harness-mode"
                            label="When"
                            model={() => ui.mode}
                            options={[{ value: 'drain', label: 'When its turns end' }, { value: 'now', label: 'Now — interrupt its running turns' }]}
                        />
                        {updating?.running.length ? (
                            <div data-update-impact>
                                <p data-update-impact-label>Running turns on {updating.name} · {updating.running.length}</p>
                                {turnLinks(updating.running)}
                            </div>
                        ) : null}
                    </div>
                </ConfirmDialog>
                <ConfirmDialog
                    model={() => ui.removing !== ''}
                    title={`Remove ${removing?.name ?? 'the runtime'} from ${props.name}?`}
                    description="The daemon deletes its build. No environment on this machine runs on it; it can be installed again from here."
                    confirmLabel={`Remove ${removing?.name ?? 'it'}`}
                    cancelLabel="Keep it"
                    onCancel={() => { ui.removing = ''; }}
                    onConfirm={() => { const r = removing; ui.removing = ''; if (r) emit('request', { op: 'remove', runtime: r.runtime, mode: 'drain' }); }}
                />
            </section>
            )}
            </Card.Root>
        );
    };
});
