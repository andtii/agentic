/**
 * `EventsLostRow` — the amber mono line a session log shows after a
 * reconnect with a gap (`docs/design/HANDOFF.md` → "Edge cases", "Event gap
 * after reconnect"): "Events lost between seq A and B". The session is
 * `disconnected`, not in error, so the line is a `needs-you` tone, not
 * `failed`. Rendered as a list item to sit inside the event log's `<ol>`,
 * or a div anywhere else.
 */
import { component, type Define } from '@sigx/runtime-core';

export type EventsLostRowProps =
    & Define.Prop<'from', number, true>
    & Define.Prop<'to', number, true>
    & Define.Prop<'as', 'li' | 'div'>
    & Define.Prop<'class', string>;

const style = 'display: flex; align-items: center; gap: var(--space-sm); font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-warning); padding: var(--space-xs) 0';

export function eventsLostText(from: number, to: number): string {
    return `Events lost between seq ${from} and ${to}`;
}

export const EventsLostRow = component<EventsLostRowProps>(({ props }) => () => {
    const text = eventsLostText(props.from, props.to);
    return props.as === 'div'
        ? <div data-events-lost="" data-tone="needs-you" role="note" class={props.class} style={style}>{text}</div>
        : <li data-events-lost="" data-tone="needs-you" role="note" class={props.class} style={style}>{text}</li>;
}, { name: 'EventsLostRow' });
