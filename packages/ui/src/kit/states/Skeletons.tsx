/**
 * Skeleton presets on zero's `Skeleton` (`docs/design/HANDOFF.md` →
 * "Element states" (loading), "Edge cases" (slow connection): 14 px bars
 * in `--ag-line` (the design system's skeleton override), three rows for a
 * table, a card's header + two lines, a rail's stacked cards. The shell and
 * the connection strip render first from SSR; these stand in for the data.
 * Each preset is `aria-busy` with a visually hidden "Loading" so a reader
 * hears one announcement, not one per bar.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Skeleton } from '@sigx/zero';

const Bar = component<Define.Prop<'width', string> & Define.Prop<'height', string>>(({ props }) => () => (
    <Skeleton.Root class="ag-skeleton-bar">
        <span style={`display: block; inline-size: ${props.width ?? '100%'}; block-size: ${props.height ?? '14px'}`} aria-hidden="true" />
    </Skeleton.Root>
), { name: 'SkeletonBar' });

const wrap = (preset: string, label: string, cls: string | undefined, style: string, children: unknown) => (
    <div data-skeleton={preset} aria-busy="true" role="status" class={cls} style={style}>
        <span data-visually-hidden="">{label}</span>
        {children as never}
    </div>
);

export type TableSkeletonProps =
    & Define.Prop<'rows', number>
    /** Column widths; the bars take the same template as the table (`100px 1fr 60px`). */
    & Define.Prop<'cols', string>
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>;

/** Three rows of bars in the table's own column template. */
export const TableSkeleton = component<TableSkeletonProps>(({ props }) => () => {
    const cols = (props.cols ?? '1fr 1fr 1fr').split(/\s+/).filter(Boolean);
    const rows = Array.from({ length: props.rows ?? 3 }, (_, i) => i);
    return wrap('table', props.label ?? 'Loading', props.class, 'display: flex; flex-direction: column; gap: var(--space-md); padding: var(--space-md) var(--space-lg)',
        rows.map(() => (
            <div data-skeleton-row="" style={`display: grid; grid-template-columns: ${cols.join(' ')}; column-gap: var(--space-lg); align-items: center`}>
                {cols.map(() => <Bar width="70%" />)}
            </div>
        ))
    );
}, { name: 'TableSkeleton' });

export type CardSkeletonProps = Define.Prop<'lines', number> & Define.Prop<'label', string> & Define.Prop<'class', string>;

/** A card: a title bar and two lines, inside the card chrome. */
export const CardSkeleton = component<CardSkeletonProps>(({ props }) => () => {
    const lines = Array.from({ length: props.lines ?? 2 }, (_, i) => i);
    return wrap('card', props.label ?? 'Loading', props.class, 'display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-xl); border: var(--border) solid var(--ag-line); border-radius: var(--radius-box); background: var(--color-base-200)',
        [<Bar width="40%" height="18px" />, ...lines.map((i) => <Bar width={i % 2 ? '60%' : '85%'} />)]
    );
}, { name: 'CardSkeleton' });

export type RailSkeletonProps = Define.Prop<'cards', number> & Define.Prop<'label', string> & Define.Prop<'class', string>;

/** A side rail: stacked card skeletons. */
export const RailSkeleton = component<RailSkeletonProps>(({ props }) => () => {
    const cards = Array.from({ length: props.cards ?? 2 }, (_, i) => i);
    return wrap('rail', props.label ?? 'Loading', props.class, 'display: flex; flex-direction: column; gap: var(--space-lg)',
        cards.map(() => <CardSkeleton lines={2} label="" />)
    );
}, { name: 'RailSkeleton' });
