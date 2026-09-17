import { component, type Define } from 'sigx';
import { Label } from '@agentic/ui';

export type PanelProps =
    /** The mono uppercase label at the top of the card. */
    & Define.Prop<'label', string>
    /** Right-aligned beside the label: a link, a pill. */
    & Define.Slot<'aside'>
    & Define.Prop<'tone', 'failed' | 'needs-you'>
    & Define.Prop<'class', string>
    & Define.Prop<'aria-label', string>
    & Define.Slot<'default'>;

/** A base-200 card with a `--ag-line` border and radius 8 — the rail card every screen uses. */
export const Panel = component<PanelProps>(({ props, slots }) => () => (
    <section data-panel data-tone={props.tone} class={props.class} aria-label={props['aria-label'] ?? props.label}>
        {props.label || slots.aside ? (
            <header data-panel-head>
                {props.label ? <Label>{props.label}</Label> : null}
                {slots.aside ? <span data-panel-aside>{slots.aside()}</span> : null}
            </header>
        ) : null}
        {slots.default?.()}
    </section>
));
