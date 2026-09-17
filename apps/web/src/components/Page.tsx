import { component, useHead, type Define } from 'sigx';
import { Stack } from '@agentic/ui';

export type PageProps =
    & Define.Prop<'title', string, true>
    & Define.Prop<'subtitle', string>
    /** The `data-page` key `styles/pages.css` lays the page out by (`home`, `chat`, …). */
    & Define.Prop<'page', string>
    /** The handoff draws no page heading on these screens: keep the `<h1>` for assistive tech, hide it visually. */
    & Define.Prop<'hideTitle', boolean>
    /** Chat runs edge to edge: the page is one grid, not a stack. */
    & Define.Prop<'flush', boolean>
    & Define.Slot<'default'>;

/**
 * A routed page: document title, heading, and a vertical stack of content.
 * With `page`, the section carries `data-page` so the per-screen grid in
 * `styles/pages.css` applies; the stack then becomes the page's own grid.
 */
export const Page = component<PageProps>(({ props, slots }) => {
    useHead({ title: props.title });
    return () => {
        const heading = (
            <div data-page-heading data-visually-hidden={props.hideTitle ? '' : undefined}>
                <h1 data-page-title>{props.title}</h1>
                {props.subtitle ? <p data-page-subtitle>{props.subtitle}</p> : null}
            </div>
        );
        if (props.page) {
            return (
                <section aria-label={props.title} data-page={props.page} data-flush={props.flush ? '' : undefined}>
                    {heading}
                    {slots.default?.()}
                </section>
            );
        }
        return (
            <Stack as="section" gap="xl" aria-label={props.title}>
                {heading}
                {slots.default?.()}
            </Stack>
        );
    };
});
