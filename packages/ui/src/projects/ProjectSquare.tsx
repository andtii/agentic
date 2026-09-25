/**
 * `ProjectSquare` — a project's mark: a rounded square in the project's colour with its initial
 * (docs/design/projects/HANDOFF.md, "Sub-menu" and "Overview"). The colour is one of the four agent hues, tinted like
 * an agent tile (fill 12 %, border 40 %, the initial in the hue); unset, it is picked from `id` (or the name) so a
 * project keeps one colour everywhere. 22 px in lists and the sub-menu, 44 px in the Overview header. Decorative: the
 * project's name always sits beside it.
 */
import { component, type Define } from '@sigx/runtime-core';
import { PROJECT_COLORS, type ProjectColor } from '@agentic/core';

export type ProjectSquareProps =
    & Define.Prop<'name', string, true>
    /** The stored colour; unset, the square picks one from `id` (or the name). */
    & Define.Prop<'color', ProjectColor>
    & Define.Prop<'id', string>
    /** Edge length in px (22 in lists and the sub-menu, 44 in the Overview header); 22 by default. */
    & Define.Prop<'size', number>
    & Define.Prop<'class', string>;

/** The colour a project without a stored one gets: a stable hash of `key` onto `PROJECT_COLORS`. */
export function projectColorFor(key: string): ProjectColor {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return PROJECT_COLORS[hash % PROJECT_COLORS.length]!;
}

/** The first letter or digit of the name, upper-cased; `?` when there is none. */
export function projectInitial(name: string): string {
    const match = /[\p{L}\p{N}]/u.exec(name);
    return match ? match[0].toUpperCase() : '?';
}

function squareStyle(color: ProjectColor, size: number): string {
    const hue = `var(--ag-agent-${PROJECT_COLORS.indexOf(color) + 1})`;
    return [
        'display: inline-flex', 'align-items: center', 'justify-content: center', 'flex-shrink: 0', 'box-sizing: border-box',
        `inline-size: ${size}px`, `block-size: ${size}px`, `border-radius: ${size >= 36 ? 10 : 6}px`,
        'border-width: 1px', 'border-style: solid', `border-color: color-mix(in oklab, ${hue} 40%, transparent)`, `background-color: color-mix(in oklab, ${hue} 12%, transparent)`,
        `color: ${hue}`, 'font-family: var(--font-mono)', `font-size: ${Math.round(size / 2)}px`, 'font-weight: 600', 'line-height: 1'
    ].join('; ');
}

export const ProjectSquare = component<ProjectSquareProps>(({ props }) => () => {
    const size = props.size ?? 22;
    const color = props.color ?? projectColorFor(props.id ?? props.name);
    return (
        <span data-ag-project="square" data-color={color} data-size={size} class={props.class} style={squareStyle(color, size)} aria-hidden="true">
            {projectInitial(props.name)}
        </span>
    );
}, { name: 'ProjectSquare' });
