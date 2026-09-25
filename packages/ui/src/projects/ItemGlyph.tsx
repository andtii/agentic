/**
 * `ItemGlyph` — a plan item's state as a 16 px square (docs/design/projects/HANDOFF.md, "Plan"): ready is hollow
 * (`text-muted`), claimed / needs you / stuck are filled 20 % in `working` / `needs-you` / `failed`, blocked is dashed
 * (`text-dim`), done is filled `line-strong` with a check. Colour is never the only signal: the glyph is named by its
 * state unless the row already says it in text (`label=""`).
 */
import { component, type Define } from '@sigx/runtime-core';

/** The plan item states the glyph draws (docs/design/projects/HANDOFF.md, "Plan"). */
export type ItemGlyphState = 'ready' | 'claimed' | 'needs-you' | 'blocked' | 'done' | 'stuck';

export type ItemGlyphProps =
    & Define.Prop<'state', ItemGlyphState, true>
    /** The accessible name; defaults to the state in words ("Needs you"). `''` makes the glyph decorative, for a row that says the state in text. */
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>;

/** Each state in words — the glyph's default accessible name. */
export const ITEM_GLYPH_TEXT: Readonly<Record<ItemGlyphState, string>> = {
    ready: 'Ready',
    claimed: 'Claimed',
    'needs-you': 'Needs you',
    blocked: 'Blocked',
    done: 'Done',
    stuck: 'Stuck'
};

const base = 'display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box; inline-size: 16px; block-size: 16px; border-radius: 4px';
const filled = (token: string) => `${base}; border-width: 1.5px; border-style: solid; border-color: ${token}; background-color: color-mix(in oklab, ${token} 20%, transparent)`;

const STYLE: Readonly<Record<ItemGlyphState, string>> = {
    ready: `${base}; border-width: 1.5px; border-style: solid; border-color: var(--ag-text-muted)`,
    claimed: filled('var(--color-info)'),
    'needs-you': filled('var(--color-warning)'),
    blocked: `${base}; border-width: 1.5px; border-style: dashed; border-color: var(--ag-text-dim)`,
    done: `${base}; background-color: var(--ag-line-strong); color: var(--color-base-content)`,
    stuck: filled('var(--color-error)')
};

const check = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m5 12 5 5 9-10" />
    </svg>
);

export const ItemGlyph = component<ItemGlyphProps>(({ props }) => () => {
    const label = props.label ?? ITEM_GLYPH_TEXT[props.state];
    const mark = props.state === 'done' ? check() : null;
    return label
        ? <span data-ag-project="item-glyph" data-state={props.state} class={props.class} style={STYLE[props.state]} role="img" aria-label={label}>{mark}</span>
        : <span data-ag-project="item-glyph" data-state={props.state} class={props.class} style={STYLE[props.state]} aria-hidden="true">{mark}</span>;
}, { name: 'ItemGlyph' });
