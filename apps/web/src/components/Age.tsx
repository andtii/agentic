import { component, type Define } from 'sigx';
import { formatAge, formatDateTime } from '../mock/workspace';
import { clockNow, zoneFormat } from '../time';

export type AgeProps =
    /** Epoch ms. */
    & Define.Prop<'at', number, true>
    /** The clock to measure against; default: the real one on the platform, the mock workspace's otherwise. */
    & Define.Prop<'now', number>
    /** The workspace's IANA zone (`useWorkspaceZone`); absent, the mock workspace's. */
    & Define.Prop<'zone', string>
    & Define.Prop<'class', string>;

/**
 * A relative age in mono (`14m`, `3h`) that becomes a date after 24 h, with
 * the full workspace-zone time as the title (docs/design/HANDOFF.md → Edge
 * cases, time zones).
 */
export const Age = component<AgeProps>(({ props }) => () => {
    const now = props.now ?? clockNow();
    const fmt = props.zone ? zoneFormat(props.zone) : null;
    return (
        <time data-age dateTime={new Date(props.at).toISOString()} title={fmt ? fmt.dateTime(props.at) : formatDateTime(props.at)} class={props.class}>
            {fmt ? fmt.age(props.at, now) : formatAge(props.at, now)}
        </time>
    );
});
