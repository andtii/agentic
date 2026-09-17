import { component, type Define } from 'sigx';
import { formatAge, formatDateTime, MOCK_NOW } from '../mock/workspace';

export type AgeProps =
    /** Epoch ms. */
    & Define.Prop<'at', number, true>
    /** The clock to measure against; the mock workspace's by default. */
    & Define.Prop<'now', number>
    & Define.Prop<'class', string>;

/**
 * A relative age in mono (`14m`, `3h`) that becomes a date after 24 h, with
 * the full workspace-zone time as the title (docs/design/HANDOFF.md → Edge
 * cases, time zones).
 */
export const Age = component<AgeProps>(({ props }) => () => (
    <time data-age dateTime={new Date(props.at).toISOString()} title={formatDateTime(props.at)} class={props.class}>
        {formatAge(props.at, props.now ?? MOCK_NOW)}
    </time>
));
