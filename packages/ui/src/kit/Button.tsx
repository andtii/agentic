/**
 * `Button` — the handoff's five intents on zero's `Button.Root`
 * (`docs/design/HANDOFF.md` → "Components", "Element states"): `primary`
 * (live fill), `default` (base-300 fill, `line-strong` border), `wait`
 * (amber: the answer to something waiting on a person), `danger` (outline
 * until the confirm step, then filled) and `icon` (36 px square, needs an
 * accessible name). Loading keeps the label and swaps the icon for zero's
 * `spinner` part; zero's `loading` sets `data-state="loading"`, `aria-busy`
 * and `aria-disabled` and blocks activation without the native `disabled`,
 * so the button the person just pressed keeps focus.
 *
 * With `href` it renders a real `<a>` through `Button.Root asChild`, so a
 * navigation carries the same intent axes and anatomy as a button.
 */
import { component, type Define, type JSXElement } from '@sigx/runtime-core';
import { Button as ZeroButton } from '@sigx/zero';
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
    /** Renders a link (`<a href>`) wearing the same button anatomy and intent. */
    & Define.Prop<'href', string>
    & Define.Prop<'form', string>
    & Define.Prop<'name', string>
    & Define.Prop<'value', string>
    & Define.Prop<'class', string>
    & Define.Prop<'onClick', (e: MouseEvent) => void>
    & Define.Slot<'default'>;

export const Button = component<ButtonProps>(({ props, slots }) => () => {
    const intent = props.intent ?? 'default';
    if (__DEV__ && intent === 'icon' && !props.label) {
        throw new Error('[@agentic/ui] an icon Button needs a `label` — every icon-only control has an aria-label');
    }
    const axes = buttonAxes(intent, props.confirm);
    const mods = { ...axes.mods, block: !!props.block };
    const content = (): JSXElement[] => [
        // zero draws the spinner part while loading; the icon gives way to it.
        props.loading || !props.icon ? null : <Icon name={props.icon} size={15} />,
        intent === 'icon' ? null : <span>{slots.default?.()}</span>
    ];
    const onClick = (e: MouseEvent): void => props.onClick?.(e);
    if (props.href !== undefined) {
        return (
            <ZeroButton.Root asChild color={axes.color as never} variant={axes.variant as never} mods={mods} loading={props.loading} disabled={props.disabled} aria-label={props.label} data-intent={intent} onClick={onClick}>
                {(part) => (
                    <a {...part} href={props.href} class={props.class}>
                        {props.loading ? <span data-scope="button" data-part="spinner" aria-hidden="true" /> : null}
                        {content()}
                    </a>
                )}
            </ZeroButton.Root>
        );
    }
    return (
        <ZeroButton.Root
            color={axes.color as never}
            variant={axes.variant as never}
            mods={mods}
            loading={props.loading}
            disabled={props.disabled}
            type={props.type ?? 'button'}
            form={props.form}
            name={props.name}
            value={props.value}
            aria-label={props.label}
            data-intent={intent}
            class={props.class}
            onClick={onClick}
        >
            {content()}
        </ZeroButton.Root>
    );
}, { name: 'Button' });
