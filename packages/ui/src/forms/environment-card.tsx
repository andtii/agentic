/**
 * `EnvironmentCard` — one execution environment as the user must be able
 * to see it (EXE-06): runtime, account (and its auth status), machine (and
 * whether it is online), concurrency and isolation. `environmentStatus`
 * folds those signals into one state the card stamps as `data-env-state`.
 *
 * Drawn to `docs/design/HANDOFF.md` → "Components" (`EnvironmentCard`) on
 * the kit's `ag-env-card` scope: name, runtime + account, a capacity meter
 * (one 18 × 6 segment per slot, `working` when used), the queued count,
 * "Default for" tiles, the isolation mechanism. Expired or missing auth
 * turns the border `failed` (`data-tone`), shows the `AUTH EXPIRED` pill
 * and a fix line with `Re-check`; an offline machine dims the card. With
 * `quota`, the account's provider limits follow (`QuotaPanel`, #270).
 */

import { component, type Define } from '@sigx/runtime-core';
import { Status } from '@sigx/zero';
import type { EnvironmentDescriptor, EnvironmentId, EnvironmentTelemetry, MachineInfo, QuotaSnapshot } from '@agentic/core';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { agEnvCardAnatomy } from '../kit/anatomy.js';
import { Button } from '../kit/Button.js';
import { QuotaPanel } from '../kit/QuotaMeter.js';
import { StatusPill } from '../kit/StatusPill.js';
import { formatBytes } from '../thread/text.js';
import type { Tone } from '../kit/vocabulary.js';

const SCOPE = agEnvCardAnatomy.scope;

export type EnvironmentState = 'ready' | 'busy' | 'offline' | 'auth-missing' | 'auth-expired' | 'auth-unknown';

export interface EnvironmentStatus {
    readonly state: EnvironmentState;
    readonly label: string;
    readonly color: 'success' | 'warning' | 'error' | 'neutral';
    /** The card's tone: `failed` border for auth, `dim` for an offline machine, `working` while busy. */
    readonly tone: Tone;
}

/** Machine offline beats auth, auth beats capacity: the first thing the user has to fix comes first. */
export function environmentStatus(env: EnvironmentDescriptor, machine?: MachineInfo): EnvironmentStatus {
    if (machine && !machine.online) return { state: 'offline', label: 'Machine offline', color: 'neutral', tone: 'dim' };
    switch (env.account.authStatus) {
        case 'missing':
            return { state: 'auth-missing', label: 'Not signed in', color: 'error', tone: 'failed' };
        case 'expired':
            return { state: 'auth-expired', label: 'Sign-in expired', color: 'error', tone: 'failed' };
        case 'unknown':
            return { state: 'auth-unknown', label: 'Sign-in status unknown', color: 'warning', tone: 'muted' };
        default:
            break;
    }
    const { active, max } = env.concurrency;
    if (active >= max) return { state: 'busy', label: `Busy (${active}/${max})`, color: 'warning', tone: 'working' };
    return { state: 'ready', label: 'Ready', color: 'success', tone: 'live' };
}

/** The auth pill for an account: AUTH OK, AUTH EXPIRED, NOT SIGNED IN, UNKNOWN. */
export function authPill(env: EnvironmentDescriptor): 'auth-ok' | 'auth-expired' | 'auth-missing' | 'unknown' {
    switch (env.account.authStatus) {
        case 'ok':
            return 'auth-ok';
        case 'expired':
            return 'auth-expired';
        case 'missing':
            return 'auth-missing';
        default:
            return 'unknown';
    }
}

/** The fix line under a card whose auth needs a person. */
export function authFixLine(env: EnvironmentDescriptor): string | undefined {
    switch (env.account.authStatus) {
        case 'expired':
            return `The ${env.account.label} account can no longer authenticate. Work for it is held, not moved to another account.`;
        case 'missing':
            return `The ${env.account.label} account is not signed in on this machine.`;
        default:
            return undefined;
    }
}

export interface DefaultForAgent {
    readonly name: string;
    readonly hue?: AgentHue;
}

export type EnvironmentCardProps = Define.Prop<'environment', EnvironmentDescriptor, true> &
    Define.Prop<'machine', MachineInfo> &
    Define.Prop<'selected', boolean> &
    /** Renders a select button with this text; `select` fires with the environment id. */
    Define.Prop<'selectLabel', string> &
    Define.Prop<'disabled', boolean> &
    /** Tasks queued for this environment (an offline machine holds them; EXE-12). */
    Define.Prop<'queued', number> &
    /** The agents that default to this environment. */
    Define.Prop<'defaultFor', readonly DefaultForAgent[]> &
    /** The account's provider limits (#270); `null` shows "No usage reported yet", absent shows nothing. */
    Define.Prop<'quota', QuotaSnapshot | null> &
    /** What its sessions cost the machine (#400), as the daemon attributed it; `null`: the daemon reports load but none for this environment (idle); absent shows nothing. */
    Define.Prop<'load', EnvironmentTelemetry | null> &
    Define.Event<'select', EnvironmentId> &
    Define.Event<'recheck', EnvironmentId>;

/** `CPU 12 % · 1.8 GB` for a sample; `idle` with no sample entry; `load unknown` when the daemon could not attribute it. */
export function environmentLoadText(load: EnvironmentTelemetry | null): string {
    if (load === null) return 'idle';
    if (load.sample === null) return 'load unknown';
    return `CPU ${load.sample.cpu === null ? '—' : `${Math.round(load.sample.cpu * 100)}\u00a0%`} · ${formatBytes(load.sample.rss)}`;
}

/** The tooltip: how the number was made, or why there is none. */
export function environmentLoadTitle(load: EnvironmentTelemetry | null, runtime: string): string {
    if (load === null) return 'No session runs here';
    switch (load.attribution) {
        case 'session':
            return load.sample ? `The sessions here and everything they started (${load.sample.processes} processes)` : 'No session here has started its process yet';
        case 'environment':
            return `${runtime} keeps one process per environment; its sessions are not told apart`;
        case 'none':
            return `${runtime} starts its own runtime; the daemon cannot see its process`;
    }
}

export const EnvironmentCard = component<EnvironmentCardProps>(
    ({ props, emit }) =>
        () => {
            const env = props.environment;
            const machine = props.machine;
            const status = environmentStatus(env, machine);
            const fix = authFixLine(env);
            const slots = Array.from({ length: Math.max(env.concurrency.max, 0) }, (_, i) => i < env.concurrency.active);
            return (
                <article data-scope={SCOPE} data-part="root" data-tone={status.tone} data-env-state={status.state} data-mod-selected={props.selected ? '' : undefined} aria-label={env.name}>
                    <div data-scope={SCOPE} data-part="header">
                        <h3 data-scope={SCOPE} data-part="name">{env.name}</h3>
                        <span data-scope={SCOPE} data-part="status">
                            <Status.Root color={status.color} />
                            <span>{status.label}</span>
                        </span>
                        <StatusPill status={authPill(env)} />
                    </div>
                    <p data-scope={SCOPE} data-part="line">
                        <span>{env.runtime}</span>
                        <span aria-hidden="true"> · </span>
                        <span>
                            {env.account.label}
                            {env.account.identity ? ` (${env.account.identity})` : ''}
                        </span>
                    </p>
                    <div data-scope={SCOPE} data-part="capacity" role="img" aria-label={`${env.concurrency.active} of ${env.concurrency.max} sessions in use`}>
                        <span data-scope={SCOPE} data-part="meter" aria-hidden="true">
                            {slots.map((used) => <span data-scope={SCOPE} data-part="slot" data-used={used ? '' : undefined} />)}
                        </span>
                        <span data-scope={SCOPE} data-part="count">
                            {env.concurrency.active} of {env.concurrency.max}
                        </span>
                        {props.queued ? <span data-scope={SCOPE} data-part="queued">{props.queued} queued</span> : null}
                        {props.load !== undefined ? <span data-scope={SCOPE} data-part="load" title={environmentLoadTitle(props.load, env.runtime)}>{environmentLoadText(props.load)}</span> : null}
                    </div>
                    <dl data-scope={SCOPE} data-part="facts">
                        <dt>Machine</dt>
                        <dd>
                            {machine?.name ?? env.machineId}
                            {machine ? (machine.online ? ' — online' : ' — offline') : ''}
                        </dd>
                        <dt>Isolation</dt>
                        <dd>{env.isolation}</dd>
                        {env.cwdRoots.length ? (
                            <>
                                <dt>Working roots</dt>
                                <dd>{env.cwdRoots.join(', ')}</dd>
                            </>
                        ) : null}
                        {props.defaultFor?.length ? (
                            <>
                                <dt>Default for</dt>
                                <dd data-scope={SCOPE} data-part="default-for">
                                    {props.defaultFor.map((a) => <AgentTile name={a.name} hue={a.hue} size={20} labelled />)}
                                </dd>
                            </>
                        ) : null}
                    </dl>
                    {fix ? (
                        <p data-scope={SCOPE} data-part="fix">
                            <span>{fix}</span>
                            <Button intent="default" onClick={() => emit('recheck', env.id)}>Re-check</Button>
                        </p>
                    ) : null}
                    {props.quota !== undefined ? (
                        <div data-scope={SCOPE} data-part="quota">
                            <QuotaPanel snapshot={props.quota} />
                        </div>
                    ) : null}
                    {props.selectLabel ? (
                        <div data-scope={SCOPE} data-part="actions">
                            <Button intent="default" disabled={props.disabled || props.selected} onClick={() => emit('select', env.id)}>
                                {props.selectLabel}
                            </Button>
                        </div>
                    ) : null}
                </article>
            );
        },
    { name: 'EnvironmentCard' }
);
