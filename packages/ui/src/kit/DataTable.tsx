/**
 * `DataTable` — zero's `Table` with the handoff's column templates
 * (`docs/design/HANDOFF.md` → "Layout and shell", tables). `cols` is the
 * grid template the artboard was drawn with (`100px 1fr 140px 270px 60px`):
 * fixed tracks become the column spec's widths, `fr` tracks share the slack.
 * Head row 10 / 16 in the mono label voice, body rows 14 / 16 — both from
 * the table recipe. The whole row is not clickable: the ref or name cell is
 * the link. While `loading`, three skeleton rows stand in for the body.
 *
 * Below `md` the table becomes stacked cards ("Responsive behaviour"): zero's
 * `Table.Root stack="md"` makes each row one block and prints each cell's
 * column label inside it (the `cell-label` part) — for every cell that names
 * its `column`, which is why callers write `<DataTable.Cell column={i}>`. The
 * geometry is zero's structure layer, the card chrome the `table` patch; the
 * server render never has to guess the viewport and hydration matches. Below
 * `xl` the drawn widths yield (the `table` patch's `column` rule).
 */
import { component, type Define } from '@sigx/runtime-core';
import { Skeleton, Table, VisuallyHidden, type TableColumn } from '@sigx/zero';

export interface DataColumn {
    readonly label: string;
    /** Right-align numbers and ages. */
    readonly align?: 'start' | 'end';
    /** Visually hidden head text (an actions column); a stacked cell prints no label for it. */
    readonly hidden?: boolean;
}

/** `"100px 1fr 140px"` → one column width per track; `fr` tracks are `auto`. */
export function parseCols(cols: string): (string | undefined)[] {
    return cols.trim().split(/\s+/).map((track) => (track.endsWith('fr') ? undefined : track));
}

/** The zero column spec: a hidden column has no `label`, so a stacked cell prints none for it. */
export function tableColumns(cols: string, columns: readonly DataColumn[]): TableColumn[] {
    const widths = parseCols(cols);
    return columns.map((c, i) => ({
        ...(c.hidden ? {} : { label: c.label }),
        ...(widths[i] ? { width: widths[i] } : {}),
        ...(c.align ? { align: c.align } : {})
    }));
}

export type DataTableProps =
    & Define.Prop<'cols', string, true>
    & Define.Prop<'columns', readonly DataColumn[], true>
    /** The table's accessible name. */
    & Define.Prop<'label', string, true>
    & Define.Prop<'loading', boolean>
    & Define.Prop<'class', string>
    /** The body rows: `DataTable.Row` / `DataTable.Cell column={i}` (zero's `Table.Row` / `Table.Cell`). */
    & Define.Slot<'default'>;

const Root = component<DataTableProps>(({ props, slots }) => () => {
    if (__DEV__ && parseCols(props.cols).length !== props.columns.length) {
        throw new Error(`[@agentic/ui] DataTable: ${parseCols(props.cols).length} tracks in cols but ${props.columns.length} columns`);
    }
    return (
        <Table.Root class={props.class} columns={tableColumns(props.cols, props.columns)} stack="md" mods={{ hover: true }}>
            <Table.Caption>
                <VisuallyHidden>{props.label}</VisuallyHidden>
            </Table.Caption>
            {/* The head row names every column, a hidden one too: its label is read, not seen. */}
            <Table.Head>
                <Table.Row>
                    {props.columns.map((c, i) => (
                        <Table.HeaderCell column={i}>{c.hidden ? <VisuallyHidden>{c.label}</VisuallyHidden> : c.label}</Table.HeaderCell>
                    ))}
                </Table.Row>
            </Table.Head>
            <Table.Body>
                {props.loading
                    ? [0, 1, 2].map(() => (
                        <Table.Row>
                            {props.columns.map((_, i) => (
                                <Table.Cell column={i}>
                                    <Skeleton.Root model={() => true}>
                                        <VisuallyHidden>Loading</VisuallyHidden>
                                    </Skeleton.Root>
                                </Table.Cell>
                            ))}
                        </Table.Row>
                    ))
                    : slots.default?.()}
            </Table.Body>
        </Table.Root>
    );
}, { name: 'DataTable' });

export const DataTable = Object.assign(Root, { Row: Table.Row, Cell: Table.Cell });
