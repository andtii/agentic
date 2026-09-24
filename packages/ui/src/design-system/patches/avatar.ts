import type { RecipePatch } from '@sigx/zero-kit/define';
import { mono } from './shared.js';

/** The tile sizes the artboards draw, in px (`AgentTile`'s `size`, rendered as `data-tile`). */
const TILES = [18, 20, 22, 24, 28, 32, 44, 52] as const;
/** The four identity hue slots (`data-hue`). */
const HUES = [1, 2, 3, 4] as const;

// Avatar: the identity tile `AgentTile` is. An agent is a `square` (radius 6)
// with a two-letter mono monogram in its hue — fill at 12 %, border at 40 %;
// a person is a `circle` on base-300 with the `line-strong` border and no
// hue. No ring. `data-tile` sets `--ag-tile` (18–52 px, 32 by default) and
// `data-hue` sets `--ag-hue`; the monogram is 11/32 of the tile.
const patch: RecipePatch = {
    parts: {
        root: {
            base: {
                '--ag-tile': '32px',
                '--ag-hue': 'var(--ag-text-muted)',
                width: 'var(--ag-tile)',
                height: 'var(--ag-tile)',
                flexShrink: '0',
                boxSizing: 'border-box',
                boxShadow: 'none',
                border: 'var(--border) solid color-mix(in oklab, var(--ag-hue) 40%, transparent)',
                background: 'color-mix(in oklab, var(--ag-hue) 12%, transparent)',
                color: 'var(--ag-hue)'
            },
            selectors: {
                ...Object.fromEntries(TILES.map((px) => [`&[data-tile="${px}"]`, { '--ag-tile': `${px}px` }])),
                ...Object.fromEntries(HUES.map((hue) => [`&[data-hue="${hue}"]`, { '--ag-hue': `var(--ag-agent-${hue})` }]))
            }
        },
        fallback: {
            base: {
                background: 'transparent',
                color: 'inherit',
                fontFamily: mono,
                fontWeight: 'var(--weight-semibold)',
                fontSize: 'calc(var(--ag-tile) * 0.34375)',
                lineHeight: 'var(--leading-none)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--tracking-normal)'
            }
        }
    },
    variants: {
        shape: {
            square: { root: { base: { borderRadius: 'var(--radius-field)' } } },
            // People: the shape is the only way to tell agent from user at 18 px.
            circle: { root: { base: { background: 'var(--color-base-300)', borderColor: 'var(--ag-line-strong)', color: 'var(--color-base-content)' } } }
        }
    }
};

export default patch;
