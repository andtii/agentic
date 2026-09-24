import { component, type Define } from 'sigx';
import { Card } from '@sigx/zero';
import { Label } from '@agentic/ui';

export type PanelTone = 'failed' | 'needs-you';

export type PanelProps =
    /** The mono uppercase label at the top of the card. */
    & Define.Prop<'label', string>
    /** Right-aligned beside the label: a link, a pill. */
    & Define.Slot<'aside'>
    & Define.Prop<'tone', PanelTone>
    & Define.Prop<'class', string>
    & Define.Prop<'aria-label', string>
    & Define.Slot<'default'>;

/** A tone is the card's colour role (`roleOf`): failed → error, needs-you → warning. */
const TONE_COLOR = { failed: 'error', 'needs-you': 'warning' } as const;

/**
 * The rail card every screen uses: zero's `Card` (the design system's card
 * patch draws base-200, the `--ag-line` border, radius 8) rendered as a named
 * `<section>`, the label as its title beside the aside, the content its body.
 * A tone is the card's colour; `data-tone` stays on the root for tests.
 */
export const Panel = component<PanelProps>(({ props, slots }) => () => (
    <Card.Root
        asChild
        color={props.tone ? TONE_COLOR[props.tone] : undefined}
        data-panel=""
        data-tone={props.tone}
        aria-label={props['aria-label'] ?? props.label}
    >
        {(part: Record<string, unknown>) => (
            <section {...part} class={props.class}>
                {props.label || slots.aside ? (
                    <Card.Header data-panel-head="">
                        {props.label ? <Card.Title><Label>{props.label}</Label></Card.Title> : null}
                        {slots.aside ? <span data-panel-aside>{slots.aside()}</span> : null}
                    </Card.Header>
                ) : null}
                <Card.Body data-panel-body="">{slots.default?.()}</Card.Body>
            </section>
        )}
    </Card.Root>
));
