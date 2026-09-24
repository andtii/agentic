/**
 * `ErrorNote` — an error line on zero's `Alert` (`role="alert"`, the error
 * colour, the small size), with an optional title. It replaces hand-stamped
 * `<p role="alert">` / `<div role="alert">` error lines: each site passes its
 * own `data-*` hook (`data-form-summary`, `data-save-error`, …), which the
 * alert forwards to its root, so page styles and tests keep their selector.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Alert } from '@sigx/zero';
import { htmlAttrs, type WithHtmlAttrs } from '@sigx/zero/contract';

export type ErrorNoteProps =
    & Define.Prop<'title', string>
    & Define.Prop<'class', string>
    /** `aria-*`, the site's `data-*` hook and `id`; the root is always the alert, so no `role` (and `title` is the heading). */
    & Omit<WithHtmlAttrs, 'role' | 'title'>
    & Define.Slot<'default'>;

export const ErrorNote = component<ErrorNoteProps>(({ props, slots }) => () => {
    const { role: _role, title: _title, ...attrs } = htmlAttrs(props);
    return (
        <Alert.Root {...attrs} color="error" size="sm" class={props.class}>
            {props.title ? <Alert.Title>{props.title}</Alert.Title> : null}
            <Alert.Description>{slots.default?.()}</Alert.Description>
        </Alert.Root>
    );
}, { name: 'ErrorNote' });
