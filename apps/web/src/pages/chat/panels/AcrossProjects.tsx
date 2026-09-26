/**
 * The chat panel's **Across projects** card (#762; PRJ-16; board `PMChat`): the items this chat links across
 * projects (`acrossProjects`) — the item a request was filed as (`signalx#14 filed`) and the chat project's items that
 * wait on it (`agentic#16 waits`) — with a Links link. Renders nothing while the chat links nothing.
 *
 * #931: each row reads its item live from that project's Plan and shows the item's real state and PR
 * (`working · PR signalx#88`, `blocked`), falling back to the request's view (`filed`, `waits`) until it is there.
 */
import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import type { ProjectId } from '@agentic/core';
import type { AcrossItem, AcrossState } from '@agentic/platform';
import { Icon, Label } from '@agentic/ui';
import { usePlanItems } from '../../projects/work/live';
import { linkedItemLine, type AgentNameOf } from '../entries/RequestCard';

const STATE_TEXT: Readonly<Record<AcrossState, string>> = { filed: 'filed', waits: 'waits', open: 'open' };

export type AcrossProjectsProps = Define.Prop<'items', readonly AcrossItem[], true> & Define.Prop<'agentName', AgentNameOf>;

type AcrossLiveProps = Define.Prop<'item', AcrossItem, true> & Define.Prop<'projectId', ProjectId, true> & Define.Prop<'agentName', AgentNameOf>;

/** The project as the ref writes it (`signalx#14` → `signalx`). */
const projectOfRef = (ref: string): string => ref.slice(0, ref.lastIndexOf('#'));

/** One linked item, its line read live from its project's Plan. */
const AcrossLive = component<AcrossLiveProps>(({ props }) => {
    const items = usePlanItems(() => props.projectId);
    return () => {
        const live = items().find((i) => i.id === props.item.n);
        return (
            <li data-mini-node data-across-item={props.item.state} data-across-live={live?.state}>
                <span data-requests-chip="project"><Icon name="folder" size={12} />{props.item.ref}</span>
                <span data-requests-mono="">{live ? linkedItemLine(live, projectOfRef(props.item.ref), props.agentName) : STATE_TEXT[props.item.state]}</span>
            </li>
        );
    };
}, { name: 'AcrossProjectsItem' });

export const AcrossProjects = component<AcrossProjectsProps>(({ props }) => () =>
    props.items.length ? (
        <section data-context-section data-across-projects="" aria-label="Across projects">
            <header data-context-head>
                <Label>Across projects</Label>
                <Link to="/projects/links">Links</Link>
            </header>
            <ul data-mini-tree>
                {props.items.map((item) =>
                    item.projectId ? (
                        <AcrossLive key={item.ref} item={item} projectId={item.projectId} {...(props.agentName ? { agentName: props.agentName } : {})} />
                    ) : (
                        <li key={item.ref} data-mini-node data-across-item={item.state}>
                            <span data-requests-chip="project"><Icon name="folder" size={12} />{item.ref}</span>
                            <span data-requests-mono="">{STATE_TEXT[item.state]}</span>
                        </li>
                    )
                )}
            </ul>
        </section>
    ) : null, { name: 'AcrossProjects' });
