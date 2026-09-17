import { component, useHead, type Define } from 'sigx';
import { Stack } from '@agentic/ui';

export type PageProps =
    & Define.Prop<'title', string, true>
    & Define.Prop<'subtitle', string>
    & Define.Slot<'default'>;

/** A routed page: document title, heading, and a vertical stack of content. */
export const Page = component<PageProps>(({ props, slots }) => {
    useHead({ title: props.title });
    return () => (
        <Stack as="section" gap="xl" aria-label={props.title}>
            <Stack gap="xs">
                <h1 data-page-title>{props.title}</h1>
                {props.subtitle ? <p data-page-subtitle>{props.subtitle}</p> : null}
            </Stack>
            {slots.default?.()}
        </Stack>
    );
});
