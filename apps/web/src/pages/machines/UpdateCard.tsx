import { component, signal, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import type { HostOs, UpdateSettings } from '@agentic/core';
import type { MachineUpdateView } from '@agentic/platform';
import { Button, ConfirmDialog, Label, StatusPill, ageText } from '@agentic/ui';
import { CommandWell } from './CommandWell';
import { UpdatePolicyForm, type UpdateChoice } from './UpdatePolicyForm';
import { BADGE_TEXT, canSelfUpdate, drainingText, impactText, lastLine, phaseSteps, policyLabel, progressPercent, reinstallCommand, restartWarning, rollbackTarget, runningLine, updateBadge } from './update';

/** A running turn as the card names it: who runs it, and the session it runs in. */
export type TurnLabel = (turn: MachineUpdateView['impact']['runningTurns'][number]) => string;

export type UpdateCardProps =
    & Define.Prop<'update', MachineUpdateView, true>
    & Define.Prop<'name', string, true>
    & Define.Prop<'os', HostOs, true>
    /** The bare version a daemon without a build reports. */
    & Define.Prop<'daemonVersion', string>
    /** The platform origin the reinstall line points at. */
    & Define.Prop<'origin', string, true>
    & Define.Prop<'timeZone', string, true>
    /** The workspace's defaults, offered in the channel and policy selectors. */
    & Define.Prop<'defaults', UpdateSettings, true>
    & Define.Prop<'turnLabel', TurnLabel>
    & Define.Prop<'now', number, true>
    /** A request is on its way (the buttons wait). */
    & Define.Prop<'busy', boolean>
    /** Why the last action was refused. */
    & Define.Prop<'failure', string | null>
    /** `requestUpdate` said "reinstall once": the installer line shows. */
    & Define.Prop<'reinstall', boolean>
    & Define.Event<'request', 'drain' | 'now'>
    & Define.Event<'cancel'>
    & Define.Event<'rollback'>
    & Define.Event<'saveUpdates', UpdateChoice>
    /** "Check for updates" (#468): read the release manifests now instead of waiting for the hourly read. */
    & Define.Event<'check'>
    /** A check is out. */
    & Define.Prop<'checking', boolean>
    /** Below the card's own content: the mock's state picker. */
    & Define.Slot<'default'>;

const turnHref = (t: MachineUpdateView['impact']['runningTurns'][number]): string => (t.taskId ? `/tasks/${t.taskId}` : `/sessions/${t.sessionId}`);

/**
 * The Machine page's daemon update card (#367; EXE-08, OPS-03, OPS-04),
 * over `Machine.updateState()`: the running build; a newer release with
 * "What's new" and **Update when idle** (drain), **Update now** (a confirm
 * naming the running turns it interrupts) and **Schedule** (a window
 * policy); a pending update's phases with the download's progress, the
 * turns a drain waits for, and **Cancel**; how the last update ended and
 * **Roll back**; the channel and policy, the workspace's as the defaults.
 * A daemon that cannot update itself gets the installer line to run once.
 */
export const UpdateCard = component<UpdateCardProps>(({ props, emit, slots }) => {
    const ui = signal({ confirmNow: false, windowAsk: 0 });
    const turnLinks = (): JSXElement => (
        <ul data-update-turns>
            {props.update.impact.runningTurns.map((t) => (
                <li data-update-turn={t.sessionId}><Link to={turnHref(t)} class="ag-ref">{props.turnLabel ? props.turnLabel(t) : `${t.agentId} · ${t.sessionId}`}</Link></li>
            ))}
        </ul>
    );
    const reinstallBlock = (lead: string): JSXElement => (
        <div data-update-reinstall>
            <p data-card-text>{lead}</p>
            <CommandWell command={reinstallCommand(props.origin, props.os)} />
            <p data-card-text>It upgrades in place: the machine stays paired, its environments and sign-ins stay. From then on it updates from this page.</p>
        </div>
    );

    return () => {
        const u = props.update;
        const badge = updateBadge(u);
        const able = canSelfUpdate(u);
        const pending = u.pending;
        const offline = !u.online;
        const busy = !!props.busy;
        const last = pending ? null : lastLine(u.last, props.timeZone);
        // A cancel is the owner's own choice, not a failure: only a failed, rolled-back or timed-out update is an alert.
        const lastFailed = u.last !== undefined && u.last.outcome !== 'applied' && u.last.outcome !== 'cancelled';
        const back = pending ? null : rollbackTarget(u);
        const restarts = restartWarning(u, props.now, props.timeZone);
        const percent = progressPercent(pending?.progress);
        const state = !able ? 'no-feature' : pending ? 'pending' : u.available ? 'available' : 'current';
        return (
            <section data-card data-update-card data-update-state={state} data-tone={u.outdated ? 'failed' : undefined} aria-label="Daemon updates">
                <div data-label-row>
                    <Label>Daemon updates</Label>
                    {badge ? <StatusPill status={badge} label={BADGE_TEXT[badge].label} tone={BADGE_TEXT[badge].tone} /> : null}
                </div>
                {u.outdated ? <p data-update-banner role="alert">Update required: the platform no longer serves this daemon's version. It connects, but new work waits until it is updated.</p> : null}
                <p data-update-running>{runningLine(u, props.daemonVersion)}</p>
                {restarts ? <p data-update-restarts role="status">{restarts}</p> : null}

                {!able ? reinstallBlock(`This daemon predates updates — reinstall once with the one-line installer on ${props.name}:`) : null}

                {able && pending ? (
                    <div data-update-pending>
                        <p data-card-text>Updating to {pending.target === 'previous' ? 'the previous version' : pending.target} ({pending.mode === 'now' ? 'now' : 'when idle'}).{pending.phase ? '' : ' Asked — waiting for the daemon to report.'}</p>
                        <ol data-update-phases>
                            {phaseSteps(pending).map((s) => (
                                <li data-update-phase={s.phase} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
                                    <span data-update-phase-label>{s.label}</span>
                                    {s.phase === 'downloading' && s.state === 'current' && percent !== null
                                        ? <progress data-update-progress max={100} value={percent} aria-label={`Downloaded ${percent}%`}>{percent}%</progress>
                                        : null}
                                    {s.phase === 'draining' && s.state === 'current' ? (
                                        <div data-update-draining>
                                            <span>{drainingText(u.impact)}</span>
                                            {u.impact.runningTurns.length ? turnLinks() : null}
                                        </div>
                                    ) : null}
                                </li>
                            ))}
                        </ol>
                        {pending.error ? <p data-update-error role="alert">{pending.error.message}</p> : null}
                        <div data-card-actions>
                            <Button intent="default" loading={busy} disabled={busy} onClick={() => emit('cancel')}>Cancel update</Button>
                        </div>
                    </div>
                ) : null}

                {able && !pending && u.available ? (
                    <div data-update-available>
                        <p data-update-version>
                            <span>{u.available.version} available</span>
                            {u.available.notesUrl ? <a href={u.available.notesUrl} target="_blank" rel="noopener noreferrer" data-update-notes>What's new</a> : null}
                        </p>
                        {offline ? <p data-env-note>The machine is offline. It can update once its daemon is connected.</p> : null}
                        <div data-card-actions>
                            <Button intent="primary" loading={busy} disabled={busy || offline} onClick={() => emit('request', 'drain')}>Update when idle</Button>
                            <Button intent="default" disabled={busy || offline} onClick={() => { ui.confirmNow = true; }}>Update now</Button>
                            <Button intent="default" disabled={busy} onClick={() => { ui.windowAsk += 1; }}>Schedule…</Button>
                        </div>
                    </div>
                ) : null}
                {able && !pending && !u.available ? <p data-card-text data-update-current>Up to date on {u.channel}.</p> : null}
                {able && !pending ? (
                    <p data-update-checked>
                        <span>{props.checking ? 'Checking for updates…' : u.checkedAt !== undefined ? `Checked ${ageText(Math.max(0, props.now - u.checkedAt))}` : 'Not checked yet'}</span>
                        <button type="button" data-link-button data-update-check disabled={props.checking} onClick={() => emit('check')}>Check for updates</button>
                    </p>
                ) : null}

                {last ? <p data-update-last data-tone={lastFailed ? 'failed' : undefined} role={lastFailed ? 'alert' : undefined}>{last}</p> : null}
                {able && back ? (
                    <div data-card-actions>
                        <Button intent="default" loading={busy} disabled={busy || offline} onClick={() => emit('rollback')}>Roll back to {back}</Button>
                    </div>
                ) : null}

                {props.reinstall && able ? reinstallBlock('The daemon said it cannot update itself. Reinstall once with the one-line installer:') : null}
                {props.failure ? <p data-update-error role="alert">{props.failure}</p> : null}

                <p data-card-text data-update-follows>
                    {u.inherited.channel && u.inherited.policy
                        ? `Follows the workspace: ${u.channel}, ${policyLabel(u.policy)}.`
                        : `Channel ${u.channel}${u.inherited.channel ? ' (workspace)' : ''}; takes updates ${policyLabel(u.policy)}${u.inherited.policy ? ' (workspace)' : ''}.`}
                </p>
                <UpdatePolicyForm
                    name="machine-update"
                    channel={u.inherited.channel ? null : u.channel}
                    policy={u.inherited.policy ? null : u.policy}
                    inherit={props.defaults}
                    timeZone={props.timeZone}
                    busy={busy}
                    windowAsk={ui.windowAsk}
                    onSave={(choice: UpdateChoice) => emit('saveUpdates', choice)}
                />
                {slots.default?.()}

                <ConfirmDialog
                    model={() => ui.confirmNow}
                    title={`Update ${props.name} now?`}
                    description={impactText(u.impact)}
                    confirmLabel={u.impact.runningTurns.length ? `Interrupt ${u.impact.runningTurns.length} and update` : 'Update now'}
                    cancelLabel="Not now"
                    onCancel={() => { ui.confirmNow = false; }}
                    onConfirm={() => { ui.confirmNow = false; emit('request', 'now'); }}
                >
                    {u.impact.runningTurns.length ? (
                        <div data-update-impact>
                            <p data-update-impact-label>Running turns that are interrupted · {u.impact.runningTurns.length}</p>
                            {turnLinks()}
                        </div>
                    ) : null}
                </ConfirmDialog>
            </section>
        );
    };
});
