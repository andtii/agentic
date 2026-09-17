/**
 * `ConnectionStrip` — the card at the sidebar foot, one row per signal
 * (`docs/design/HANDOFF.md` → "Layout and shell"): this browser's socket,
 * then each machine. Dot + name + mono state. It is the always-visible
 * half of failure distinction (OPS-04); the states issue supplies the
 * signal-to-row mapping, this scope draws the rows.
 */
import { component, type Define } from '@sigx/runtime-core';
import { agConnectionAnatomy } from './anatomy.js';
import type { Tone } from './vocabulary.js';

const SCOPE = agConnectionAnatomy.scope;

export interface ConnectionRow {
    readonly id: string;
    readonly name: string;
    /** Mono state text: `live`, `2 sessions`, `offline 3h`, `reconnecting…`. */
    readonly state: string;
    readonly tone: Tone;
    /** Nothing is happening: hollow dot. */
    readonly hollow?: boolean;
}

export type ConnectionStripProps =
    & Define.Prop<'rows', readonly ConnectionRow[], true>
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>;

export const ConnectionStrip = component<ConnectionStripProps>(({ props }) => () => (
    <ul data-scope={SCOPE} data-part="root" aria-label={props.label ?? 'Connections'} class={props.class}>
        {props.rows.map((row) => (
            <li data-scope={SCOPE} data-part="row" data-tone={row.tone} data-mod-hollow={row.hollow ? '' : undefined} data-id={row.id}>
                <span data-scope={SCOPE} data-part="dot" aria-hidden="true" />
                <span data-scope={SCOPE} data-part="name">{row.name}</span>
                <span data-scope={SCOPE} data-part="state">{row.state}</span>
            </li>
        ))}
    </ul>
), { name: 'ConnectionStrip' });
