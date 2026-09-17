import { component, type Define } from '@sigx/runtime-core';
import { layoutAttrs, type LayoutProps } from './attrs';

export type Orientation = 'vertical' | 'horizontal';

/** The elements a Stack may render as — layout is geometry, the tag is the meaning. */
export type StackTag =
    | 'div' | 'section' | 'article' | 'aside' | 'nav' | 'header' | 'footer' | 'main'
    | 'ul' | 'ol' | 'li' | 'form' | 'span';

export type StackProps =
    & LayoutProps
    & Define.Prop<'orientation', Orientation>
    & Define.Prop<'as', StackTag>
    & Define.Prop<'class', string>
    & Define.Prop<'id', string>
    & Define.Prop<'role', string>
    & Define.Prop<'aria-label', string>
    & Define.Slot<'default'>;

function createStack(name: string, orientation: Orientation) {
    return component<StackProps>(({ props, slots }) => {
        return () => {
            const Tag = props.as ?? 'div';
            return (
                <Tag
                    data-scope="stack"
                    data-part="root"
                    data-orientation={props.orientation ?? orientation}
                    class={props.class}
                    id={props.id}
                    role={props.role}
                    aria-label={props['aria-label']}
                    {...layoutAttrs(props)}
                >
                    {slots.default?.()}
                </Tag>
            );
        };
    }, { name });
}

/**
 * Stack — one flex container, `data-orientation` vertical by default.
 * `Row` and `Col` are the same scope with a different default orientation,
 * so a design system paints one recipe and one manifest entry.
 */
export const Stack = createStack('Stack', 'vertical');
/** A horizontal Stack. */
export const Row = createStack('Row', 'horizontal');
/** A vertical Stack — Stack's own default, named for symmetry with Row. */
export const Col = createStack('Col', 'vertical');
