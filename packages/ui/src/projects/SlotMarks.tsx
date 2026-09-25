/**
 * `SlotMarks` — which of the five project feature slots a feature plugs into, one 22 px mark each: Section, Overview
 * card, Work stages, Chat context, Agent instructions and tools (#725 stub; #726 draws it). Props are final.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { ProjectFeatureUi } from '@agentic/core';

/** The five slots, in mark order. */
export const PROJECT_FEATURE_SLOTS = ['section', 'overviewCard', 'workStages', 'chatRefPrefixes', 'tools'] as const;
export type ProjectFeatureSlot = (typeof PROJECT_FEATURE_SLOTS)[number];

export type SlotMarksProps =
    /** The feature manifest's `ui` block; absent, every mark is empty. */
    & Define.Prop<'ui', ProjectFeatureUi>
    /** The plugin has `instructions`: the last mark fills even without `ui.tools`. */
    & Define.Prop<'instructions', boolean>
    & Define.Prop<'class', string>;

/** The slots `ui` (and `instructions`) fill, in mark order. */
export function usedSlots(ui: ProjectFeatureUi | undefined, instructions = false): ProjectFeatureSlot[] {
    return PROJECT_FEATURE_SLOTS.filter((slot) => (slot === 'tools' ? instructions || !!ui?.tools?.length : ui?.[slot] !== undefined));
}

export const SlotMarks = component<SlotMarksProps>(({ props }) => () => (
    <span data-ag-project="slot-marks" data-used={usedSlots(props.ui, props.instructions).join(' ')} class={props.class} />
), { name: 'SlotMarks' });
