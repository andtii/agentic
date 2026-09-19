import { component, type Define, type JSXElement } from 'sigx';
import type { EnvironmentDescriptor, QuotaSnapshot } from '@agentic/core';
import { AgentTile, EnvironmentCard, Icon, StatusPill } from '@agentic/ui';
import { defaultAgentsFor, opsAgent, type OpsMachine } from '../../mock/ops';
import { LinkButton } from '../ops/LinkButton';
import type { DefaultForAgent } from './live';

/** The mock workspace's "Default for" tiles by environment id. */
export const mockDefaultFor: Readonly<Record<string, readonly DefaultForAgent[]>> = Object.fromEntries(Object.entries(defaultAgentsFor).map(([env, ids]) => [env, ids.map(id => ({ name: opsAgent(id).name, hue: opsAgent(id).hue }))]));

/** Tasks queued per environment id (EXE-12) and the agents defaulting to each — what the mock workspace and the actors both provide. */
export type EnvironmentFacts =
    & Define.Prop<'queued', Readonly<Record<string, number>>, true>
    & Define.Prop<'defaultFor', Readonly<Record<string, readonly DefaultForAgent[]>>, true>
    /** Provider limits by environment id (#270); absent: the cards show none. */
    & Define.Prop<'quota', Readonly<Record<string, QuotaSnapshot>>>;

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

export type MachineGroupProps = Define.Prop<'machine', OpsMachine, true> & Define.Prop<'environments', readonly EnvironmentDescriptor[], true> & EnvironmentFacts;

/** One bordered group per machine on `/machines`: glyph, name, OS and heartbeat, status, Details, then its environments. */
export const MachineGroup = component<MachineGroupProps>(({ props }) => () => {
    const m = props.machine;
    const queued = queuedLine(m, props.environments.reduce((n, e) => n + (props.queued[e.id] ?? 0), 0));
    return (
        <section data-machine-group data-machine={m.id} data-online={m.online ? '' : undefined} aria-label={m.name}>
            <header data-machine-head>
                <span data-machine-glyph aria-hidden="true"><Icon name="machines" size={20} /></span>
                <div data-machine-title>
                    <span data-machine-name>{m.name}</span>
                    <span data-machine-caption>{m.osLabel} · daemon {m.daemonVersion} · {m.online ? `heartbeat ${m.seen}` : `last seen ${m.seen}`}</span>
                </div>
                <StatusPill status={m.online ? 'online' : 'offline'} />
                <LinkButton to={`/machines/${m.id}`}>Details</LinkButton>
            </header>
            <EnvironmentGrid environments={props.environments} machine={m} queued={props.queued} defaultFor={props.defaultFor} quota={props.quota} />
            {queued ? (
                <p data-machine-queued>
                    <Icon name="schedules" size={14} />
                    <span>{queued}</span>
                </p>
            ) : null}
        </section>
    );
});

/** The `platform` row: `anthropic-api` runs without any machine, so both execution types sit in one list. */
export const PlatformRow = component<Define.Prop<'defaultFor', readonly DefaultForAgent[], true> & Define.Prop<'caption', string, true> & Define.Prop<'keyStatus', string, true> & Define.Prop<'keyLabel', string, true>>(({ props }) => () => (
    <section data-machine-group data-platform aria-label="platform">
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
    </section>
));
