/**
 * A folder field with its picker (#193): `WorkdirField` shows the choice,
 * "Change…" opens `WorkdirPicker` on it, "Clear" goes back to the
 * environment's default. What the agent Config tab, the Start task dialog
 * and the New schedule dialog put in their forms.
 */
import { component, signal, type Define } from 'sigx';
import type { EnvironmentId, WorkdirRef } from '@agentic/core';
import { WorkdirField, type WorkdirEnvironment, type WorkdirSelection } from '@agentic/ui';
import { WorkdirPicker } from './WorkdirPicker';

export type WorkdirInputProps =
    & Define.Prop<'value', WorkdirRef | null>
    & Define.Prop<'environments', readonly WorkdirEnvironment[], true>
    & Define.Prop<'machineOf', (environmentId: string) => string | undefined>
    /** The environment the picker opens on when nothing is chosen yet. */
    & Define.Prop<'preferred', EnvironmentId | null>
    & Define.Prop<'label', string>
    & Define.Prop<'description', string>
    & Define.Prop<'placeholder', string>
    /** Hidden inputs `${name}.environmentId` / `${name}.path`, so the form posts before hydration. */
    & Define.Prop<'name', string>
    & Define.Prop<'disabled', boolean>
    /** A pick carries the folder's git badge when the listing showed one (#333); Clear is `null`. */
    & Define.Event<'change', WorkdirSelection | null>;

export const WorkdirInput = component<WorkdirInputProps>(({ props, emit }) => {
    const st = signal({ open: false });
    return () => (
        <span data-workdir-input>
            <WorkdirField
                value={props.value ?? null}
                environments={props.environments}
                {...(props.label ? { label: props.label } : {})}
                {...(props.description ? { description: props.description } : {})}
                {...(props.placeholder ? { placeholder: props.placeholder } : {})}
                {...(props.name ? { name: props.name } : {})}
                disabled={!!props.disabled}
                onOpen={() => { st.open = true; }}
                onClear={() => emit('change', null)}
            />
            <WorkdirPicker
                model={() => st.open}
                value={props.value ?? null}
                environments={props.environments}
                {...(props.machineOf ? { machineOf: props.machineOf } : {})}
                preferred={props.preferred ?? null}
                onSelect={(ref: WorkdirSelection) => { st.open = false; emit('change', ref); }}
                onCancel={() => { st.open = false; }}
            />
        </span>
    );
});
