/**
 * `WorkdirField` (#191) — the working folder a form carries, as a chip
 * (`alien01 / work · …\branches\47-drawer`, the full path in its title)
 * plus "Change…" (emits `open`; the page opens `WorkdirDialog`) and
 * "Clear" while one is set. Inside a `Field.Root` with its label, so the
 * chip is the labelled control; `compact` renders the chip alone as the
 * button (a chat header). With a `name`, two hidden inputs
 * (`${name}.environmentId`, `${name}.path`) post the value pre-hydration.
 */

import { component, type Define } from '@sigx/runtime-core';
import { Field } from '@sigx/zero';
import { useFieldContext } from '@sigx/zero/behaviors';
import type { WorkdirRef } from '@agentic/core';
import { agWorkdirAnatomy } from '../kit/anatomy.js';
import { Button } from '../kit/Button.js';
import { Icon } from '../kit/icons.js';
import { WORKDIR_EMPTY, workdirLabel, type WorkdirEnvironment } from './workdir-model.js';

const SCOPE = agWorkdirAnatomy.scope;

export type WorkdirFieldProps =
    & Define.Prop<'value', WorkdirRef | null>
    & Define.Prop<'environments', readonly WorkdirEnvironment[], true>
    /** Default "Working folder". */
    & Define.Prop<'label', string>
    & Define.Prop<'description', string>
    /** Default "Environment default (first root)". */
    & Define.Prop<'placeholder', string>
    /** Hidden inputs `${name}.environmentId` / `${name}.path`, so the form posts pre-hydration. */
    & Define.Prop<'name', string>
    & Define.Prop<'disabled', boolean>
    /** Chip-only rendering for a chat header (no Field label): the chip is the button. */
    & Define.Prop<'compact', boolean>
    & Define.Event<'open', void>
    & Define.Event<'clear', void>;

/** The full "environment · path" a chip's tooltip shows. */
function fullLabel(value: WorkdirRef, environments: readonly WorkdirEnvironment[]): string {
    return `${environments.find((e) => e.id === value.environmentId)?.label ?? value.environmentId} · ${value.path}`;
}

/** The chip as the field's labelled control: an `<output>` carrying the field's control id and description. */
const Chip = component<Define.Prop<'text', string, true> & Define.Prop<'title', string> & Define.Prop<'empty', boolean>>(({ props }) => {
    const field = useFieldContext();
    return () => (
        <output
            data-scope={SCOPE}
            data-part="chip"
            data-empty={props.empty ? '' : undefined}
            id={field.inert ? undefined : field.ids.control}
            aria-describedby={field.inert ? undefined : field.describedBy()}
            title={props.title}
        >
            <Icon name="folder" size={14} />
            <span>{props.text}</span>
        </output>
    );
}, { name: 'WorkdirChip' });

export const WorkdirField = component<WorkdirFieldProps>(({ props, emit }) => () => {
    const value = props.value ?? null;
    const label = props.label ?? 'Working folder';
    const text = workdirLabel(value, props.environments, props.placeholder ?? WORKDIR_EMPTY);
    const title = value ? fullLabel(value, props.environments) : undefined;
    const hidden = props.name && value ? (
        <>
            <input type="hidden" name={`${props.name}.environmentId`} value={value.environmentId} disabled={props.disabled} />
            <input type="hidden" name={`${props.name}.path`} value={value.path} disabled={props.disabled} />
        </>
    ) : null;

    if (props.compact) {
        return (
            <div data-scope={SCOPE} data-part="root" data-mod-compact="">
                <button
                    type="button"
                    data-scope={SCOPE}
                    data-part="chip"
                    data-empty={value ? undefined : ''}
                    title={title}
                    aria-label={`${label}: ${text}`}
                    disabled={props.disabled}
                    onClick={() => emit('open')}
                >
                    <Icon name="folder" size={14} />
                    <span>{text}</span>
                </button>
                {hidden}
            </div>
        );
    }

    return (
        <Field.Root disabled={props.disabled}>
            <Field.Label>{label}</Field.Label>
            <div data-scope={SCOPE} data-part="root">
                <Chip text={text} title={title} empty={!value} />
                <span data-scope={SCOPE} data-part="actions">
                    <Button intent="default" disabled={props.disabled} onClick={() => emit('open')}>Change…</Button>
                    {value ? <Button intent="default" disabled={props.disabled} onClick={() => emit('clear')}>Clear</Button> : null}
                </span>
                {hidden}
            </div>
            {props.description ? <Field.Description>{props.description}</Field.Description> : null}
        </Field.Root>
    );
}, { name: 'WorkdirField' });
