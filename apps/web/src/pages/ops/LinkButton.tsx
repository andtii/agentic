import { component, type Define } from 'sigx';
import { useRouter } from '@sigx/router';
import { variantAttrs } from '@sigx/zero/contract';
import { buttonAxes, Icon, type ButtonIntent, type IconName } from '@agentic/ui';

export type LinkButtonProps =
    & Define.Prop<'to', string, true>
    & Define.Prop<'intent', ButtonIntent>
    & Define.Prop<'icon', IconName>
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>
    & Define.Slot<'default'>;

/**
 * A navigation that looks like a kit `Button`: a real `<a href>` (works
 * without JavaScript) stamped with the button anatomy the design system
 * paints, pushed through the router when JavaScript is there.
 */
export const LinkButton = component<LinkButtonProps>(({ props, slots }) => {
    const router = useRouter();
    return () => {
        const intent = props.intent ?? 'default';
        const axes = buttonAxes(intent);
        const attrs = variantAttrs({ color: axes.color as never, variant: axes.variant, mods: axes.mods });
        return (
            <a
                href={props.to}
                data-scope="button"
                data-part="root"
                data-intent={intent}
                {...attrs}
                aria-label={props.label}
                class={props.class}
                onClick={(e: MouseEvent) => {
                    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    void router.push(props.to);
                }}
            >
                {props.icon ? <Icon name={props.icon} size={15} /> : null}
                {intent === 'icon' ? null : <span>{slots.default?.()}</span>}
            </a>
        );
    };
});
