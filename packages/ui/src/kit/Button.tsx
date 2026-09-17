/**
 * `Button` — the handoff's five intents on zero's `button` anatomy
 * (`docs/design/HANDOFF.md` → "Components", "Element states"): `primary`
 * (live fill), `default` (base-300 fill, `line-strong` border), `wait`
 * (amber: the answer to something waiting on a person), `danger` (outline
 * until the confirm step, then filled) and `icon` (36 px square, needs an
 * accessible name). Loading keeps the label and swaps the icon for a 14 px
 * spinner; the button is disabled meanwhile.
 *
 * Rendered as a real `<button>` carrying the same `data-*` axes zero's
 * `Button.Root` stamps (`variantAttrs`), so the design system's button
 * recipe paints it and every attribute a control needs (`aria-label`,
 * `aria-busy`, `form`) is ours to set.
 */
import { component, type Define } from '@sigx/runtime-core';
import { variantAttrs } from '@sigx/zero/contract';
import { Icon, type IconName } from './icons.js';

export type ButtonIntent = 'primary' | 'default' | 'wait' | 'danger' | 'icon';
export const BUTTON_INTENTS: readonly ButtonIntent[] = ['primary', 'default', 'wait', 'danger', 'icon'];

/** The daisy axes each intent resolves to — one row per intent, nothing per screen. */
export function buttonAxes(intent: ButtonIntent, confirm = false): { color: string; variant: string; mods?: Record<string, boolean> } {
    switch (intent) {
        case 'primary':
            return { color: 'primary', variant: 'solid' };
        case 'wait':
            return { color: 'warning', variant: 'solid' };
        case 'danger':
            return { color: 'error', variant: confirm ? 'solid' : 'outline' };
        case 'icon':
            return { color: 'neutral', variant: 'solid', mods: { square: true } };
        default:
            return { color: 'neutral', variant: 'solid' };
    }
}

export type ButtonProps =
    & Define.Prop<'intent', ButtonIntent>
    & Define.Prop<'type', 'button' | 'submit' | 'reset'>
    & Define.Prop<'disabled', boolean>
    & Define.Prop<'loading', boolean>
    /** Danger only: the confirm step fills the button. */
    & Define.Prop<'confirm', boolean>
    /** An icon before the label; the only content of an `icon` button. */
    & Define.Prop<'icon', IconName>
    /** Required for `icon`; sets `aria-label` on any intent. */
    & Define.Prop<'label', string>
    /** Full width (mobile rows). */
    & Define.Prop<'block', boolean>
    & Define.Prop<'form', string>
    & Define.Prop<'class', string>
    & Define.Prop<'onClick', (e: MouseEvent) => void>
    & Define.Slot<'default'>;

export const Button = component<ButtonProps>(({ props, slots }) => () => {
    const intent = props.intent ?? 'default';
    if (__DEV__ && intent === 'icon' && !props.label) {
        throw new Error('[@agentic/ui] an icon Button needs a `label` — every icon-only control has an aria-label');
    }
    const axes = buttonAxes(intent, props.confirm);
    const attrs = variantAttrs({
        color: axes.color as never,
        variant: axes.variant,
        mods: { ...axes.mods, loading: props.loading ? true : undefined, block: props.block ? true : undefined }
    });
    const disabled = props.disabled || props.loading;
    return (
        <button
            data-scope="button"
            data-part="root"
            data-intent={intent}
            {...attrs}
            type={props.type ?? 'button'}
            disabled={disabled}
            data-disabled={disabled ? '' : undefined}
            aria-busy={props.loading ? 'true' : undefined}
            aria-label={props.label}
            form={props.form}
            class={props.class}
            onClick={(e: MouseEvent) => props.onClick?.(e)}
        >
            {props.icon && !props.loading ? <Icon name={props.icon} size={15} /> : null}
            {intent === 'icon' ? null : <span>{slots.default?.()}</span>}
        </button>
    );
}, { name: 'Button' });
