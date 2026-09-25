import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { Tag } from '@agentic/ui';
import { settingsHref } from '../projects/settings/tabs';
import type { PmProject } from './pm';

export type PmChipProps =
    & Define.Prop<'project', PmProject, true>
    /** Render the chip as a link to the project's Settings › Project manager; off inside a card that is itself a link. */
    & Define.Prop<'link', boolean>;

/**
 * The project chip on a project manager (#842): "PM · <project>". On the
 * agent header it links to Settings › Project manager; on a roster card the
 * whole card is already one `<a>`, so the chip stays text there (no nested link).
 */
export const PmChip = component<PmChipProps>(({ props }) => () => {
    const tag = <Tag tone="live">PM · {props.project.name}</Tag>;
    return (
        <span data-agent-pm={props.project.id} title={`Project manager of ${props.project.name}`}>
            {props.link ? <Link to={settingsHref(props.project.id, 'manager')}>{tag}</Link> : tag}
        </span>
    );
}, { name: 'PmChip' });
