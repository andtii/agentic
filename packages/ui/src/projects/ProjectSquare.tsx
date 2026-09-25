/**
 * `ProjectSquare` — a project's mark: a rounded square in the project's colour with its initial (#725 stub; #726
 * draws it). Props are final.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { ProjectColor } from '@agentic/core';

export type ProjectSquareProps =
    & Define.Prop<'name', string, true>
    /** The stored colour; unset, the square picks one from `id` (or the name). */
    & Define.Prop<'color', ProjectColor>
    & Define.Prop<'id', string>
    /** Edge length in px (20 in the sub-menu, 36 on a card). */
    & Define.Prop<'size', number>
    & Define.Prop<'class', string>;

export const ProjectSquare = component<ProjectSquareProps>(({ props }) => () => (
    <span data-ag-project="square" data-color={props.color} data-size={props.size} class={props.class} aria-hidden="true">
        {props.name.slice(0, 1).toUpperCase()}
    </span>
), { name: 'ProjectSquare' });
