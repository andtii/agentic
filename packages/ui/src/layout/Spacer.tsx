import { component, type Define } from '@sigx/runtime-core';

export type SpacerProps = Define.Prop<'class', string>;

/**
 * Spacer — pushes its siblings apart by taking the free space of the stack
 * it sits in (`flex: 1 1 auto`). Presentational: `aria-hidden`, no content.
 */
export const Spacer = component<SpacerProps>(({ props }) => {
    return () => <span data-scope="spacer" data-part="root" class={props.class} aria-hidden="true" />;
}, { name: 'Spacer' });
