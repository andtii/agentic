/**
 * `AgentTile` — the identity mark (`docs/design/HANDOFF.md` → "Identity").
 * Agents are squares with a two-letter mono monogram in the agent's hue;
 * people are circles on the raised surface. The shape difference is the
 * only way to tell agent from user at 18 px, so keep it. Hue never means
 * status: it is one of the four identity slots, assigned by creation
 * order and stored on the agent.
 *
 * Rendered as zero's `Avatar` with the `shape` axis (square for an agent,
 * circle for a person) and the monogram as its `Fallback`. The size and the
 * hue are data hooks (`data-tile`, `data-hue`) the design system's avatar
 * patch turns into `--ag-tile` and `--ag-hue`, so the ramp lives there.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Avatar } from '@sigx/zero';

/** The identity hue slots the design defines. */
export type AgentHue = 1 | 2 | 3 | 4;
export const AGENT_HUE_SLOTS: readonly AgentHue[] = [1, 2, 3, 4];
/** The sizes drawn on the artboards, in px. */
export type TileSize = 18 | 20 | 22 | 24 | 28 | 32 | 44 | 52;

/** The hue for the n-th agent (0-based creation index) — wraps past four until a longer palette exists. */
export function hueFor(index: number): AgentHue {
    return (((Math.max(0, Math.floor(index)) % 4) + 1) as AgentHue);
}

/** Two letters: the initials of two words, else the first two letters. */
export function monogramOf(name: string): string {
    const words = name.trim().split(/[\s_-]+/).filter(Boolean);
    const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '??').slice(0, 2);
    return letters.toUpperCase();
}

export type AgentTileProps =
    & Define.Prop<'name', string, true>
    /** Identity slot 1–4; omitted = the muted tile (a person, or an agent without a slot yet). */
    & Define.Prop<'hue', AgentHue>
    & Define.Prop<'size', TileSize>
    /** A person: circle on base-300, no hue. */
    & Define.Prop<'person', boolean>
    /** Override the derived two-letter monogram. */
    & Define.Prop<'monogram', string>
    /** Decorative when the name is written next to it; labelled otherwise. */
    & Define.Prop<'labelled', boolean>
    & Define.Prop<'class', string>;

export const AgentTile = component<AgentTileProps>(({ props }) => () => {
    const hue = props.person ? undefined : props.hue;
    return (
        <Avatar.Root
            axes={{ shape: props.person ? 'circle' : 'square' }}
            data-hue={hue}
            data-tile={props.size ?? 32}
            role={props.labelled ? 'img' : undefined}
            aria-label={props.labelled ? props.name : undefined}
            aria-hidden={props.labelled ? undefined : 'true'}
            title={props.labelled ? undefined : props.name}
            class={props.class}
        >
            <Avatar.Fallback>{props.monogram ?? monogramOf(props.name)}</Avatar.Fallback>
        </Avatar.Root>
    );
}, { name: 'AgentTile' });
