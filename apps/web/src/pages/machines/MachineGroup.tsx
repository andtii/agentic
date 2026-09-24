import { component, type Define, type JSXElement } from 'sigx';
import { Card } from '@sigx/zero';
import type { EnvironmentDescriptor, EnvironmentTelemetry, QuotaSnapshot } from '@agentic/core';
import { AgentTile, EnvironmentCard, Icon, StatusPill } from '@agentic/ui';
import { defaultAgentsFor, opsAgent, type OpsMachine } from '../../mock/ops';
import { LinkButton } from '../ops/LinkButton';
import { loadText, loadTone, type DefaultForAgent, type MachineLoad } from './live';
import { BADGE_TEXT, buildLabel, type UpdateBadge } from './update';

/** The mock workspace's "Default for" tiles by environment id. */
export const mockDefaultFor: Readonly<Record<string, readonly DefaultForAgent[]>> = Object.fromEntries(Object.entries(defaultAgentsFor).map(([env, ids]) => [env, ids.map(id => ({ name: opsAgent(id).name, hue: opsAgent(id).hue }))]));

/** Tasks queued per environment id (EXE-12) and the agents defaulting to each — what the mock workspace and the actors both provide. */
export type EnvironmentFacts =
    & Define.Prop<'queued', Readonly<Record<string, number>>, true>
    & Define.Prop<'defaultFor', Readonly<Record<string, readonly DefaultForAgent[]>>, true>
    /** Provider limits by environment id (#270); absent: the cards show none. */
    & Define.Prop<'quota', Readonly<Record<string, QuotaSnapshot>>>
    /** What each environment's sessions cost the machine (#400), by environment id; absent: the cards show none. */
    & Define.Prop<'load', Readonly<Record<string, EnvironmentTelemetry>>>;

export type EnvironmentGridProps =
    & Define.Prop<'environments', readonly EnvironmentDescriptor[], true>
    & Define.Prop<'machine', OpsMachine, true>
    & EnvironmentFacts
    /** Under each card on the machine page (#239): its sign-in command, Edit and Remove. Without it the cards are the grid's own cells. */
    & Define.Prop<'actions', (env: EnvironmentDescriptor) => JSXElement | null>;

/** The three-column grid of a machine's environment cards (`repeat(3, minmax(0, 1fr))`, gap 12). */
export const EnvironmentGrid = component<EnvironmentGridProps>(({ props }) => () => (
    <div data-env-grid>
        {props.environments.map(env => {
            const card = (
                <EnvironmentCard
                    environment={env}
                    machine={props.machine}
                    queued={props.queued[env.id]}
                    defaultFor={props.defaultFor[env.id] ?? []}
                    quota={props.quota ? (props.quota[env.id] ?? null) : undefined}
                    load={props.load ? (props.load[env.id] ?? null) : undefined}
                />
            );
            const actions = props.actions?.(env);
            return actions ? <div data-env-cell data-environment={env.id}>{card}{actions}</div> : card;
        })}
    </div>
));

/** EXE-12: work queued for an offline machine stays there; it never moves to another account or machine by itself. */
export function queuedLine(machine: OpsMachine, queued: number): string | undefined {
    if (machine.online || !queued) return undefined;
    return `${queued} ${queued === 1 ? 'task is' : 'tasks are'} queued for this machine under its agent's offline policy. It will not move to another account or machine by itself.`;
}

export type MachineGroupProps = Define.Prop<'machine', OpsMachine, true> & Define.Prop<'environments', readonly EnvironmentDescriptor[], true> & EnvironmentFacts
    /** The machine's daemon update, as a pill beside its status (#367): available, draining, updating, required. */
    & Define.Prop<'update', UpdateBadge | null>
    /** How many of its runtimes have a newer harness waiting (#370): a second pill beside the daemon's. */
    & Define.Prop<'harnessUpdates', number>
    /** The machine's own CPU and memory (#400), after the heartbeat in the caption. */
    & Define.Prop<'machineLoad', MachineLoad>;

/** One machine on `/machines`, a zero `Card`: glyph, name, OS and heartbeat, status, Details in the header, then its environments. */
export const MachineGroup = component<MachineGroupProps>(({ props }) => () => {
    const m = props.machine;
    const queued = queuedLine(m, props.environments.reduce((n, e) => n + (props.queued[e.id] ?? 0), 0));
    return (
        <Card.Root asChild>
        {(card) => (
        <section {...card} data-machine-group data-machine={m.id} data-online={m.online ? '' : undefined} aria-label={m.name}>
            <Card.Header>
            <header data-machine-head>
                <span data-machine-glyph aria-hidden="true"><Icon name="machines" size={20} /></span>
                <div data-machine-title>
                    <span data-machine-name>{m.name}</span>
                    <span data-machine-caption>{m.osLabel} · {buildLabel(m.build, m.daemonVersion)} · {m.online ? `heartbeat ${m.seen}` : `last seen ${m.seen}`}{props.machineLoad ? <> · <span data-machine-load data-tone={loadTone(props.machineLoad)}>{loadText(props.machineLoad)}</span></> : null}</span>
                </div>
                {props.update ? <StatusPill status={props.update} label={BADGE_TEXT[props.update].label} tone={BADGE_TEXT[props.update].tone} class="ag-update-badge" /> : null}
                {props.harnessUpdates ? <StatusPill status="available" label={props.harnessUpdates === 1 ? '1 RUNTIME UPDATE' : `${props.harnessUpdates} RUNTIME UPDATES`} tone="needs-you" class="ag-harness-badge" /> : null}
                <StatusPill status={m.online ? 'online' : 'offline'} />
                <LinkButton to={`/machines/${m.id}`}>Details</LinkButton>
            </header>
            </Card.Header>
            <Card.Body data-card-body="">
            <EnvironmentGrid environments={props.environments} machine={m} queued={props.queued} defaultFor={props.defaultFor} quota={props.quota} load={props.load} />
            {queued ? (
                <p data-machine-queued>
                    <Icon name="schedules" size={14} />
                    <span>{queued}</span>
                </p>
            ) : null}
            </Card.Body>
        </section>
        )}
        </Card.Root>
    );
});

/** The `platform` row: `anthropic-api` runs without any machine, so both execution types sit in one list. */
export const PlatformRow = component<Define.Prop<'defaultFor', readonly DefaultForAgent[], true> & Define.Prop<'caption', string, true> & Define.Prop<'keyStatus', string, true> & Define.Prop<'keyLabel', string, true>>(({ props }) => () => (
    <Card.Root asChild>
    {(card) => (
    <section {...card} data-machine-group data-platform aria-label="platform">
        <Card.Body>
        <header data-machine-head>
            <span data-machine-glyph aria-hidden="true"><Icon name="key" size={20} /></span>
            <div data-machine-title>
                <span data-machine-name>platform</span>
                <span data-machine-caption>{props.caption}</span>
            </div>
            <span data-machine-defaults>
                <span>Default for</span>
                {props.defaultFor.map(a => <AgentTile name={a.name} hue={a.hue} size={20} labelled />)}
            </span>
            <StatusPill status={props.keyStatus} label={props.keyLabel} />
        </header>
        </Card.Body>
    </section>
    )}
    </Card.Root>
));
