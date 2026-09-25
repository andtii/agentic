/**
 * The chat panel's **Across projects** card (#762; PRJ-16; board `PMChat`): the items this chat links across
 * projects (`acrossProjects`) — the item a request was filed as (`signalx#14 filed`) and the chat project's items that
 * wait on it (`agentic#16 waits`) — with a Links link. Renders nothing while the chat links nothing.
 */
import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import type { AcrossItem, AcrossState } from '@agentic/platform';
import { Icon, Label } from '@agentic/ui';

const STATE_TEXT: Readonly<Record<AcrossState, string>> = { filed: 'filed', waits: 'waits', open: 'open' };

export type AcrossProjectsProps = Define.Prop<'items', readonly AcrossItem[], true>;

export const AcrossProjects = component<AcrossProjectsProps>(({ props }) => () =>
    props.items.length ? (
        <section data-context-section data-across-projects="" aria-label="Across projects">
            <header data-context-head>
                <Label>Across projects</Label>
                <Link to="/projects/links">Links</Link>
            </header>
            <ul data-mini-tree>
                {props.items.map((item) => (
                    <li data-mini-node data-across-item={item.state}>
                        <span data-requests-chip="project"><Icon name="folder" size={12} />{item.ref}</span>
                        <span data-requests-mono="">{STATE_TEXT[item.state]}</span>
                    </li>
                ))}
            </ul>
        </section>
    ) : null, { name: 'AcrossProjects' });
