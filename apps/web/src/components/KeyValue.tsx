import { component, type Define } from 'sigx';
import { Label } from '@agentic/ui';

export interface KeyValueRow {
    readonly label: string;
    readonly value: () => unknown;
}

export type KeyValueProps =
    & Define.Prop<'rows', readonly KeyValueRow[], true>
    /** The label column's width; 120 px on the Task page, 96 px inside approval cards. */
    & Define.Prop<'labelWidth', number>
    & Define.Prop<'class', string>;

/** Key-value rows with a fixed mono label column (docs/design/HANDOFF.md → Task contract). */
export const KeyValue = component<KeyValueProps>(({ props }) => () => (
    <dl data-kv class={props.class} style={`--kv-label: ${props.labelWidth ?? 120}px`}>
        {props.rows.map((row) => (
            <div data-kv-row>
                <Label as="dt">{row.label}</Label>
                <dd>{row.value()}</dd>
            </div>
        ))}
    </dl>
));
