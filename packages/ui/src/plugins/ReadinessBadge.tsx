/**
 * `ReadinessBadge` — a plugin's readiness as the kit's status pill: the
 * `tone` axis paints it (never `data-state`), a hollow dot says it is off.
 * What is missing rides the `title`, and `detail` renders it as text for a
 * page that has the room.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { PluginReadiness } from '@agentic/core';
import { StatusPill } from '../kit/StatusPill.js';
import { READINESS, readinessDetail } from './readiness.js';

export type ReadinessBadgeProps =
    & Define.Prop<'readiness', PluginReadiness, true>
    /** Also render the sentence (`readinessDetail`) after the pill. */
    & Define.Prop<'detail', boolean>
    & Define.Prop<'class', string>;

export const ReadinessBadge = component<ReadinessBadgeProps>(({ props }) => () => {
    const spec = READINESS[props.readiness.status];
    const detail = readinessDetail(props.readiness);
    return (
        <span data-scope="ag-plugin-card" data-part="readiness" data-readiness={props.readiness.status} title={detail} class={props.class}>
            <StatusPill status={props.readiness.status} label={spec.label} tone={spec.tone} hollow={spec.hollow} />
            {props.detail && detail ? <span data-scope="ag-plugin-card" data-part="readiness-detail">{detail}</span> : null}
        </span>
    );
}, { name: 'ReadinessBadge' });
