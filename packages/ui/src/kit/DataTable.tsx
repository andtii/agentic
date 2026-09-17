/**
 * `DataTable` — zero's `Table` with the handoff's column templates
 * (`docs/design/HANDOFF.md` → "Layout and shell", tables). `cols` is the
 * grid template the artboard was drawn with (`100px 1fr 140px 270px 60px`):
 * fixed tracks become `<col>` widths, `fr` tracks share the slack. Head
 * row 10 / 16 in the mono label voice, body rows 14 / 16 — both from the
 * table recipe. The whole row is not clickable: the ref or name cell is
 * the link. While `loading`, three skeleton rows stand in for the body.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Skeleton, Table } from '@sigx/zero';

export interface DataColumn {
    readonly label: string;
    /** Right-align numbers and ages. */
    readonly align?: 'start' | 'end';
    /** Visually hidden head text (an actions column). */
    readonly hidden?: boolean;
}

/** `"100px 1fr 140px"` → one `<col>` width per track; `fr` tracks are `auto`. */
export function parseCols(cols: string): (string | undefined)[] {
    return cols.trim().split(/\s+/).map((track) => (track.endsWith('fr') ? undefined : track));
}

export type DataTableProps =
    & Define.Prop<'cols', string, true>
    & Define.Prop<'columns', readonly DataColumn[], true>
    /** The table's accessible name. */
    & Define.Prop<'label', string, true>
    & Define.Prop<'loading', boolean>
    & Define.Prop<'class', string>
    /** The body rows: `DataTable.Row` / `DataTable.Cell` (zero's `Table.Row` / `Table.Cell`). */
    & Define.Slot<'default'>;

const Root = component<DataTableProps>(({ props, slots }) => () => {
    const widths = parseCols(props.cols);
    if (__DEV__ && widths.length !== props.columns.length) {
        throw new Error(`[@agentic/ui] DataTable: ${widths.length} tracks in cols but ${props.columns.length} columns`);
    }
    return (
        <Table.Root class={props.class} mods={{ hover: true }}>
            <colgroup>
                {widths.map((w) => <col style={w ? `width: ${w}` : undefined} />)}
            </colgroup>
            <Table.Caption>
                <span data-visually-hidden="">{props.label}</span>
            </Table.Caption>
            <Table.Head>
                <Table.Row>
                    {props.columns.map((c) => (
                        <Table.HeaderCell>
                            <span data-align={c.align} data-visually-hidden={c.hidden ? '' : undefined}>{c.label}</span>
                        </Table.HeaderCell>
                    ))}
                </Table.Row>
            </Table.Head>
            <Table.Body>
                {props.loading
                    ? [0, 1, 2].map(() => (
                        <Table.Row>
                            {props.columns.map(() => (
                                <Table.Cell>
                                    <Skeleton.Root model={() => true}>
                                        <span data-visually-hidden="">Loading</span>
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
