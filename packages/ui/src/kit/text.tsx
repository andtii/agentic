/**
 * The two text voices every page repeats (`docs/design/HANDOFF.md` →
 * "Type"): `SectionHeading` ("Needs you", "Active tasks" — 18 / 600 with an
 * optional mono count) and `Label` (column heads, card labels — mono 11 /
 * 500, uppercase, tracking 0.08em).
 */
import { component, type Define } from '@sigx/runtime-core';

export type SectionHeadingProps =
    & Define.Prop<'count', string | number>
    & Define.Prop<'level', 2 | 3>
    & Define.Prop<'class', string>
    & Define.Slot<'default'>
    /** Right-aligned caption or action. */
    & Define.Slot<'aside'>;

export const SectionHeading = component<SectionHeadingProps>(({ props, slots }) => () => {
    const heading = (
        <span style="font-size: var(--text-xl); font-weight: var(--weight-semibold); line-height: var(--leading-tight)">
            {slots.default?.()}
            {props.count !== undefined ? <span data-section-count="" style="margin-inline-start: var(--space-sm); font-family: var(--font-mono); font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--color-warning)">{props.count}</span> : null}
        </span>
    );
    return (
        <div data-section-heading="" class={props.class} style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-md); margin: 0">
            {props.level === 3 ? <h3 style="margin: 0; font: inherit">{heading}</h3> : <h2 style="margin: 0; font: inherit">{heading}</h2>}
            {slots.aside ? <span data-section-aside="" style="font-size: var(--text-sm); color: var(--ag-text-muted)">{slots.aside()}</span> : null}
        </div>
    );
}, { name: 'SectionHeading' });

export type LabelProps =
    & Define.Prop<'as', 'span' | 'div' | 'th' | 'dt'>
    & Define.Prop<'class', string>
    & Define.Slot<'default'>;

const labelStyle = 'font-family: var(--font-mono); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: var(--tracking-wider); text-transform: uppercase; color: var(--ag-text-dim)';

export const Label = component<LabelProps>(({ props, slots }) => () => {
    switch (props.as) {
        case 'div':
            return <div data-label="" class={props.class} style={labelStyle}>{slots.default?.()}</div>;
        case 'th':
            return <th data-label="" scope="col" class={props.class} style={labelStyle}>{slots.default?.()}</th>;
        case 'dt':
            return <dt data-label="" class={props.class} style={labelStyle}>{slots.default?.()}</dt>;
        default:
            return <span data-label="" class={props.class} style={labelStyle}>{slots.default?.()}</span>;
    }
}, { name: 'Label' });
