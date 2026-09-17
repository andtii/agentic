/**
 * The `data-l-*` layout vocabulary — the attribute family zero's layout tier
 * will ship (andtii/zero-wip#473). Until it does, this file is the contract:
 * a closed set of attributes whose values are the design system's `--space-*`
 * ramp and a handful of flex keywords, rendered under a `data-l-` prefix so
 * they can never collide with a design-system axis. A page laid out against
 * one skin keeps its shape under the next, because `gap="md"` means the `md`
 * rung of the ramp everywhere; the skin only decides what `--space-md` IS.
 */

/** The spacing ramp every design system declares (`--space-*`). */
export type Space = '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
/** Cross-axis alignment (`align-items`). */
export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
/** Main-axis distribution (`justify-content`). */
export type Justify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
/** The breakpoints `layout.css` emits, mobile-first: sm 640px, md 768px, lg 1024px. */
export type Breakpoint = 'sm' | 'md' | 'lg';

/** Layout facts a carrier can state at one tier. */
export interface LayoutValues {
    /** Gap between children — a ramp step, or `none`. */
    gap?: Space | 'none';
    /** Inner padding — a ramp step, or `none`. */
    pad?: Space | 'none';
    align?: Align;
    justify?: Justify;
    /** Let the children wrap onto further lines. */
    wrap?: boolean;
    /** Take the remaining space of the parent stack (`flex: 1 1 0`). */
    grow?: boolean;
}

/** `LayoutValues` plus per-breakpoint overrides, spelled `data-l-<bp>-<key>`. */
export interface LayoutProps extends LayoutValues {
    at?: Partial<Record<Breakpoint, LayoutValues>>;
}

export const LAYOUT_KEYS = ['gap', 'pad', 'align', 'justify', 'wrap', 'grow'] as const;
export const BREAKPOINTS = ['sm', 'md', 'lg'] as const;

/**
 * The attributes a set of layout props renders. Booleans are presence-only
 * (`data-l-wrap=""`, never `="false"`), exactly like zero's flags; an absent
 * or `false` value renders nothing, so a design system's default holds.
 */
export function layoutAttrs(props: LayoutProps): Record<string, string> {
    const out: Record<string, string> = {};
    write(out, '', props);
    const at = props.at;
    if (at) {
        for (const bp of BREAKPOINTS) {
            const values = at[bp];
            if (values) write(out, `${bp}-`, values);
        }
    }
    return out;
}

function write(out: Record<string, string>, prefix: string, values: LayoutValues): void {
    for (const key of LAYOUT_KEYS) {
        const v = values[key];
        if (v === undefined || v === false) continue;
        out[`data-l-${prefix}${key}`] = v === true ? '' : v;
    }
}

/** Whether a prop key belongs to the layout vocabulary (what a carrier consumes rather than forwards). */
export function isLayoutKey(key: string): key is keyof LayoutProps {
    return key === 'at' || (LAYOUT_KEYS as readonly string[]).includes(key);
}
