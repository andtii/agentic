import { component, useHead, type Define } from 'sigx';

export type OpsPageProps =
    /** The `data-page` key `styles/pages.css` grids on. */
    & Define.Prop<'page', string, true>
    & Define.Prop<'title', string, true>
    /** Show the title as the page hero (Pair); every other ops page is titled by the breadcrumb. */
    & Define.Prop<'hero', boolean>
    & Define.Prop<'maxWidth', string>
    & Define.Slot<'default'>
    /** Right-aligned page actions (the artboards draw them in the topbar; see the issue's Decisions). */
    & Define.Slot<'actions'>
    /** Left of the actions when there is no hero: filter chips, a segmented control. */
    & Define.Slot<'lead'>;

/**
 * An operations route: document title, the `data-page` carrier the page
 * grid keys on, a heading that is visible only as the Pair hero, and one
 * head row for the page's lead controls and actions.
 */
export const OpsPage = component<OpsPageProps>(({ props, slots }) => {
    useHead({ title: props.title });
    return () => (
        <section data-page={props.page} aria-label={props.title} style={props.maxWidth ? `max-inline-size: ${props.maxWidth}` : undefined}>
            <h1 data-page-title data-visually-hidden={props.hero ? undefined : ''}>{props.title}</h1>
            {slots.lead || slots.actions ? (
                <div data-page-head data-hero={props.hero ? '' : undefined}>
                    <div data-page-lead>{slots.lead?.()}</div>
                    <div data-page-actions>{slots.actions?.()}</div>
                </div>
            ) : null}
            <div data-page-body>{slots.default?.()}</div>
        </section>
    );
});
