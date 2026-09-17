import { component, type Define } from 'sigx';
import type { EnvironmentDescriptor } from '@agentic/core';
import { AgentTile, EnvironmentCard, Icon, StatusPill } from '@agentic/ui';
import { defaultAgentsFor, opsAgent, queuedFor, queuedOn, type OpsMachine } from '../../mock/ops';
import { LinkButton } from '../ops/LinkButton';

/** The three-column grid of a machine's environment cards (`repeat(3, minmax(0, 1fr))`, gap 12). */
export const EnvironmentGrid = component<Define.Prop<'environments', readonly EnvironmentDescriptor[], true> & Define.Prop<'machine', OpsMachine, true>>(({ props }) => () => (
    <div data-env-grid>
        {props.environments.map(env => (
            <EnvironmentCard
                environment={env}
                machine={props.machine}
                queued={queuedFor[env.id]}
                defaultFor={(defaultAgentsFor[env.id] ?? []).map(id => ({ name: opsAgent(id).name, hue: opsAgent(id).hue }))}
            />
        ))}
    </div>
));

/** EXE-12: work queued for an offline machine stays there; it never moves to another account or machine by itself. */
export function queuedLine(machine: OpsMachine): string | undefined {
    const n = queuedOn(machine.id);
    if (machine.online || !n) return undefined;
    return `${n} ${n === 1 ? 'task is' : 'tasks are'} queued for this machine under its agent's offline policy. It will not move to another account or machine by itself.`;
}

export type MachineGroupProps = Define.Prop<'machine', OpsMachine, true> & Define.Prop<'environments', readonly EnvironmentDescriptor[], true>;

/** One bordered group per machine on `/machines`: glyph, name, OS and heartbeat, status, Details, then its environments. */
export const MachineGroup = component<MachineGroupProps>(({ props }) => () => {
    const m = props.machine;
    const queued = queuedLine(m);
    return (
        <section data-machine-group data-online={m.online ? '' : undefined} aria-label={m.name}>
            <header data-machine-head>
                <span data-machine-glyph aria-hidden="true"><Icon name="machines" size={20} /></span>
                <div data-machine-title>
                    <span data-machine-name>{m.name}</span>
                    <span data-machine-caption>{m.osLabel} · daemon {m.daemonVersion} · {m.online ? `heartbeat ${m.seen}` : `last seen ${m.seen}`}</span>
                </div>
                <StatusPill status={m.online ? 'online' : 'offline'} />
                <LinkButton to={`/machines/${m.id}`}>Details</LinkButton>
            </header>
            <EnvironmentGrid environments={props.environments} machine={m} />
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
export const PlatformRow = component<Define.Prop<'defaultFor', readonly string[], true> & Define.Prop<'caption', string, true> & Define.Prop<'keyStatus', string, true> & Define.Prop<'keyLabel', string, true>>(({ props }) => () => (
    <section data-machine-group data-platform aria-label="platform">
        <header data-machine-head>
            <span data-machine-glyph aria-hidden="true"><Icon name="key" size={20} /></span>
            <div data-machine-title>
                <span data-machine-name>platform</span>
                <span data-machine-caption>{props.caption}</span>
            </div>
            <span data-machine-defaults>
                <span>Default for</span>
                {props.defaultFor.map(id => <AgentTile name={opsAgent(id).name} hue={opsAgent(id).hue} size={20} labelled />)}
            </span>
            <StatusPill status={props.keyStatus} label={props.keyLabel} />
        </header>
    </section>
));
