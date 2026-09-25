/**
 * `ItemGlyph` — a plan item's state as a 16 px square: hollow, filled, dashed, checked (#725 stub; #726 draws it).
 * Props are final.
 */
import { component, type Define } from '@sigx/runtime-core';

/** The plan item states the glyph draws (docs/design/projects/HANDOFF.md, "Plan"). */
export type ItemGlyphState = 'ready' | 'claimed' | 'needs-you' | 'blocked' | 'done' | 'stuck';

export type ItemGlyphProps =
    & Define.Prop<'state', ItemGlyphState, true>
    /** The accessible name; without it the glyph is decorative. */
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>;

export const ItemGlyph = component<ItemGlyphProps>(({ props }) => () => (props.label
    ? <span data-ag-project="item-glyph" data-state={props.state} class={props.class} role="img" aria-label={props.label} />
    : <span data-ag-project="item-glyph" data-state={props.state} class={props.class} aria-hidden="true" />
), { name: 'ItemGlyph' });
