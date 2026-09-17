/**
 * `Switch` — zero's `Switch` with its label as content: 40 × 24, `role="switch"`
 * and `aria-checked` from zero, the `live` track from the design system
 * (`docs/design/HANDOFF.md` → "Components"). The label may be visually
 * hidden (`hideLabel`) where the row already says what the switch does.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Switch as ZeroSwitch } from '@sigx/zero';

export type SwitchProps =
    & Define.Model<boolean>
    & Define.Prop<'label', string, true>
    & Define.Prop<'hideLabel', boolean>
    & Define.Prop<'name', string>
    & Define.Prop<'disabled', boolean>
    & Define.Prop<'class', string>
    & Define.Event<'checkedChange', boolean>;

export const Switch = component<SwitchProps>(({ props, emit }) => () => (
    <ZeroSwitch.Root model={props.model} name={props.name} disabled={props.disabled} class={props.class} onCheckedChange={(v) => emit('checkedChange', v)}>
        <span data-visually-hidden={props.hideLabel ? '' : undefined}>{props.label}</span>
    </ZeroSwitch.Root>
), { name: 'Switch' });
