/**
 * `Segmented` — a single-choice segmented control on zero's `ToggleGroup`
 * (`docs/design/HANDOFF.md` → "Components"): a 2 px inset track, 30 px
 * segments, `aria-pressed` per item. A segment may carry a tone: the
 * approval policy's allow / ask / deny takes its meaning colour at 15 %
 * when selected (live / needs-you / failed). Tones are painted through the
 * toggle-group's own accent tokens, set per item, so the design system's
 * recipe stays the only source of the look.
 */
import { component, signal, type Define } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import { ToggleGroup } from '@sigx/zero';
import type { Tone } from './vocabulary.js';

export interface SegmentedOption {
    readonly value: string;
    readonly label: string;
    readonly tone?: Tone;
    readonly disabled?: boolean;
}

const toneInk: Record<Tone, string> = {
    muted: 'var(--ag-text-muted)',
    dim: 'var(--ag-text-dim)',
    live: 'var(--color-primary)',
    working: 'var(--color-info)',
    'needs-you': 'var(--color-warning)',
    failed: 'var(--color-error)'
};

/** The inline accent a toned segment paints when selected: ink at 15 % as fill, the ink as text. */
export function segmentStyle(tone: Tone | undefined): string | undefined {
    if (!tone) return undefined;
    const ink = toneInk[tone];
    return `--toggle-group-accent: color-mix(in oklab, ${ink} 15%, transparent); --toggle-group-on-accent: ${ink}`;
}

export type SegmentedProps =
    & Define.Model<string>
    & Define.Prop<'options', readonly SegmentedOption[], true>
    /** The group's accessible name. */
    & Define.Prop<'label', string, true>
    & Define.Prop<'disabled', boolean>
    & Define.Prop<'class', string>
    & Define.Event<'valueChange', string>;

export const Segmented = component<SegmentedProps>(({ props, emit }) => {
    // The toggle group binds an array; the segmented control is one value. A
    // local signal carries the array, kept in step with the model both ways.
    const local = signal({ values: props.model?.value ? [props.model.value] : ([] as string[]) });
    watch(
        () => props.model?.value,
        (value) => {
            const next = value ? [value] : [];
            if (next[0] !== local.values[0]) local.values = next;
        }
    );
    // zero writes the array model before it fires `valueChange`, so the
    // outer model is the one to compare against: it is what a page reads.
    const pick = (values: string[]): void => {
        const next = values[values.length - 1];
        if (next === undefined) {
            local.values = local.values[0] ? [local.values[0]] : [];
            return;
        }
        if (values.length > 1) local.values = [next];
        const before = props.model ? props.model.value : undefined;
        if (props.model) props.model.value = next;
        if (next !== before) emit('valueChange', next);
    };
    return () => (
        <ToggleGroup.Root model={() => local.values} onValueChange={pick} label={props.label} disabled={props.disabled} class={props.class} data-segmented="">
            {props.options.map((option) => (
                <ToggleGroup.Item value={option.value} disabled={option.disabled} asChild>
                    {(part) => (
                        <button {...part} type="button" data-tone={option.tone} style={segmentStyle(option.tone)}>
                            {option.label}
                        </button>
                    )}
                </ToggleGroup.Item>
            ))}
        </ToggleGroup.Root>
    );
}, { name: 'Segmented' });
