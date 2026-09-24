/**
 * `StatusPill` and `Tag` on zero's `Badge` (`docs/design/HANDOFF.md` →
 * "Task status", "Components"). A pill is 22 px: a 6 px `Badge.Dot` plus a
 * mono label; its colour is the tone's role (`pillFor`), a hollow pill is
 * the `outline` variant with a ring for a dot (nothing is happening), and a
 * working state puts the dot in zero's governed `running` state. A tag is
 * the same box outlined, without a dot — for kinds (memory, schedule,
 * plugin) and wait reasons. The design system's badge patch draws both.
 *
 * The root keeps the kit's hooks: `data-status` and `data-tone` on a pill,
 * `data-tag` and `data-tone` on a tag.
 *
 * `WaitReasonLine` is the amber mono line that follows WAITING; it is the
 * `wait` part of `ag-task-node` (the one place the recipe paints it), so a
 * table row or a node render the same line.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Badge } from '@sigx/zero';
import type { WaitReason } from '@agentic/core';
import { pillFor, roleOf, waitText } from './tone.js';
import type { Tone } from './vocabulary.js';

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
    const tone = props.tone ?? spec.tone;
    const hollow = props.hollow ?? spec.hollow;
    return (
        <Badge.Root color={roleOf(tone)} variant={hollow ? 'outline' : 'soft'} data-tone={tone} data-status={props.status} class={props.class}>
            <Badge.Dot running={tone === 'working' && !hollow} />
            {props.label ?? spec.label}
        </Badge.Root>
    );
}, { name: 'StatusPill' });

export type TagProps =
    /** Neutral (muted text) unless a tone is given — coloured text, outline only. */
    & Define.Prop<'tone', Tone>
    & Define.Prop<'class', string>
    & Define.Slot<'default'>;

export const Tag = component<TagProps>(({ props, slots }) => () => {
    const tone = props.tone ?? 'muted';
    return (
        <Badge.Root color={roleOf(tone)} variant="outline" data-tone={tone} data-tag="" class={props.class}>
            {slots.default?.()}
        </Badge.Root>
    );
}, { name: 'Tag' });

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
