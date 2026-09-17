/**
 * `StatusPill`, `Tag` and `WaitReasonLine` on the `ag-pill` scope
 * (`docs/design/HANDOFF.md` → "Task status", "Components"). A pill is 22 px:
 * a 6 px dot plus a mono label; its colour is the `tone` axis, a hollow dot
 * says nothing is happening. A tag is the same box outlined, without a
 * dot — for kinds (memory, schedule, plugin) and wait reasons.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { WaitReason } from '@agentic/core';
import { agPillAnatomy } from './anatomy.js';
import { pillFor, waitText } from './tone.js';
import type { Tone } from './vocabulary.js';

const SCOPE = agPillAnatomy.scope;

export type StatusPillProps =
    /** A `TaskStatus`, `online` / `offline`, a tool phase, or free text (rendered muted). */
    & Define.Prop<'status', string, true>
    /** Override the table's label — the text is the status word by default. */
    & Define.Prop<'label', string>
    & Define.Prop<'tone', Tone>
    & Define.Prop<'hollow', boolean>
    & Define.Prop<'class', string>;

export const StatusPill = component<StatusPillProps>(({ props }) => () => {
    const spec = pillFor(props.status);
    const hollow = props.hollow ?? spec.hollow;
    return (
        <span data-scope={SCOPE} data-part="root" data-tone={props.tone ?? spec.tone} data-mod-hollow={hollow ? '' : undefined} data-status={props.status} class={props.class}>
            <span data-scope={SCOPE} data-part="dot" aria-hidden="true" />
            <span data-scope={SCOPE} data-part="label">{props.label ?? spec.label}</span>
        </span>
    );
}, { name: 'StatusPill' });

export type TagProps =
    /** Neutral (muted text) unless a tone is given — coloured text, outline only. */
    & Define.Prop<'tone', Tone>
    & Define.Prop<'class', string>
    & Define.Slot<'default'>;

export const Tag = component<TagProps>(({ props, slots }) => () => (
    <span data-scope={SCOPE} data-part="root" data-tone={props.tone ?? 'muted'} data-mod-outline="" class={props.class}>
        <span data-scope={SCOPE} data-part="dot" aria-hidden="true" />
        <span data-scope={SCOPE} data-part="label">{slots.default?.()}</span>
    </span>
), { name: 'Tag' });

export type WaitReasonLineProps =
    & Define.Prop<'wait', WaitReason, true>
    /** What the wait is about when the caller knows (`git push`). */
    & Define.Prop<'detail', string>
    & Define.Prop<'class', string>;

/** The amber mono line that always follows WAITING: `wait: approval · git push`. */
export const WaitReasonLine = component<WaitReasonLineProps>(({ props }) => () => (
    <span data-scope="ag-task-node" data-part="wait" data-wait={props.wait.kind} class={props.class}>
        {waitText(props.wait, props.detail)}
    </span>
), { name: 'WaitReasonLine' });
