import { component, type Define } from 'sigx';
import { useRouter } from '@sigx/router';
import { Card } from '@sigx/zero-daisyui/components';

export type AgentCardLinkProps =
    & Define.Prop<'to', string, true>
    & Define.Slot<'default'>;

/**
 * A roster card (`/agents`, #592): zero's `Card.Root` rendered `asChild` as
 * the link, so the whole card is one `<a href>` that works without
 * JavaScript and is pushed through the router when it is there. The router's
 * `Link` forwards no `data-*`, so it cannot wear the card's anatomy; a
 * modified or non-primary click is left to the browser (new tab, window), as
 * `Link` does.
 */
export const AgentCardLink = component<AgentCardLinkProps>(({ props, slots }) => {
    const router = useRouter();
    const onClick = (e: MouseEvent): void => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void router.push(props.to);
    };
    return () => (
        <Card.Root asChild>
            {(part) => <a {...part} href={props.to} onClick={onClick}>{slots.default?.()}</a>}
        </Card.Root>
    );
}, { name: 'AgentCardLink' });
