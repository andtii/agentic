import { component, type Define } from 'sigx';
import { useRouter } from '@sigx/router';
import { Button, type ButtonIntent, type IconName } from '@agentic/ui';

export type LinkButtonProps =
    & Define.Prop<'to', string, true>
    & Define.Prop<'intent', ButtonIntent>
    & Define.Prop<'icon', IconName>
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>
    & Define.Slot<'default'>;

/**
 * A navigation that looks like a kit `Button`: the kit Button's `href` mode,
 * a real `<a href>` (works without JavaScript) carrying zero's button anatomy
 * from `Button.Root`, pushed through the router when JavaScript is there. A
 * modified or non-primary click is left to the browser (new tab, window).
 */
export const LinkButton = component<LinkButtonProps>(({ props, slots }) => {
    const router = useRouter();
    return () => (
        <Button
            href={props.to}
            intent={props.intent}
            icon={props.icon}
            label={props.label}
            class={props.class}
            onClick={(e: MouseEvent) => {
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                void router.push(props.to);
            }}
        >
            {slots.default?.()}
        </Button>
    );
});
