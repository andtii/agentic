/**
 * `SlotMarks` — which of the five project feature slots a feature plugs into, one 22 px mark each: Section, Overview
 * card, Work stages, Chat context, Agent instructions and tools (docs/design/projects/HANDOFF.md, "Features"). A used
 * slot is drawn in `text` on a `line-strong` border, an unused one faded to `line-strong` on `line`. Colour is never
 * the only signal: each mark is a list item named `<slot>: used` / `<slot>: not used`, with the same tooltip.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { ProjectFeatureUi } from '@agentic/core';

/** The five slots, in mark order. */
export const PROJECT_FEATURE_SLOTS = ['section', 'overviewCard', 'workStages', 'chatRefPrefixes', 'tools'] as const;
export type ProjectFeatureSlot = (typeof PROJECT_FEATURE_SLOTS)[number];

/** Each slot's name, as the marks and the Features detail panel say it. */
export const PROJECT_FEATURE_SLOT_NAMES: Readonly<Record<ProjectFeatureSlot, string>> = {
    section: 'Section',
    overviewCard: 'Overview card',
    workStages: 'Work stages',
    chatRefPrefixes: 'Chat context',
    tools: 'Agent instructions and tools'
};

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

// 24-grid stroke icons from the Features board: lines, house, check, speech bubble, brain.
const ICONS: Readonly<Record<ProjectFeatureSlot, readonly string[]>> = {
    section: ['M4 7h16M4 12h16M4 17h16'],
    overviewCard: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5'],
    workStages: ['m5 12 5 5 9-10'],
    chatRefPrefixes: ['M4 5h16v11H9l-5 4z'],
    tools: ['M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3z', 'M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3']
};

const rootStyle = 'display: inline-flex; align-items: center; gap: 4px; margin: 0; padding: 0; list-style: none';
const markBase = 'display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; box-sizing: border-box; inline-size: 22px; block-size: 22px; border-radius: 4px';
const usedStyle = `${markBase}; border-width: 1px; border-style: solid; border-color: var(--ag-line-strong); color: var(--color-base-content)`;
const unusedStyle = `${markBase}; border-width: 1px; border-style: solid; border-color: var(--ag-line); color: var(--ag-line-strong)`;

export const SlotMarks = component<SlotMarksProps>(({ props }) => () => {
    const used = usedSlots(props.ui, props.instructions);
    const mark = (slot: ProjectFeatureSlot) => {
        const on = used.includes(slot);
        const name = `${PROJECT_FEATURE_SLOT_NAMES[slot]}: ${on ? 'used' : 'not used'}`;
        return (
            <li data-slot={slot} data-used={on ? '' : undefined} style={on ? usedStyle : unusedStyle} aria-label={name} title={name}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    {ICONS[slot].map((d) => <path d={d} />)}
                </svg>
            </li>
        );
    };
    return (
        <ul data-ag-project="slot-marks" data-used={used.join(' ')} class={props.class} style={rootStyle} aria-label="Feature slots">
            {PROJECT_FEATURE_SLOTS.map(mark)}
        </ul>
    );
}, { name: 'SlotMarks' });
