/**
 * The kit's recipe pack — default styling for the `ag-*` scopes on the
 * recommended token grammar plus the `--ag-*` custom properties the
 * `agentic` design system declares (`docs/design/HANDOFF.md` → "Components",
 * "States and interactions").
 *
 * Every `tone` value and every kit modifier is wired here, so the design
 * system's coverage report has nothing left "declared but unwired" from
 * this issue. Pure data: the kit import is type-only.
 */
import type { RecipeInput } from '@sigx/zero-kit';

const mono = 'var(--font-mono)';
const motion = 'var(--duration-fast) var(--ease-standard)';

/** The ink each tone paints with; tinted fills are the ink with alpha, never new tokens. */
const inks = {
    muted: 'var(--ag-text-muted)',
    dim: 'var(--ag-text-dim)',
    live: 'var(--color-primary)',
    working: 'var(--color-info)',
    'needs-you': 'var(--color-warning)',
    failed: 'var(--color-error)'
} as const;

/** `variants.tone` for a scope whose root carries `--ag-ink`. */
const toneInk = (part = 'root'): Record<string, Record<string, { base: Record<string, string> }>> =>
    Object.fromEntries(Object.entries(inks).map(([tone, ink]) => [tone, { [part]: { base: { '--ag-ink': ink } } }]));

/** Status pill: 22 px, 6 px dot, mono label; fill 8 % and border 33 % of the ink. */
const pill: RecipeInput = {
    component: 'ag-pill',
    tokens: { '--ag-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                height: 'var(--ag-pill-h)',
                padding: '0 var(--space-sm)',
                border: 'var(--border) solid color-mix(in oklab, var(--ag-ink) 33%, transparent)',
                borderRadius: 'var(--radius-selector)',
                background: 'color-mix(in oklab, var(--ag-ink) 8%, transparent)',
                color: 'var(--ag-ink)',
                fontFamily: mono,
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-medium)',
                letterSpacing: 'var(--tracking-wide)',
                lineHeight: 'var(--leading-none)',
                whiteSpace: 'nowrap',
                flexShrink: '0'
            }
        },
        dot: {
            base: {
                inlineSize: '6px',
                blockSize: '6px',
                borderRadius: '50%',
                background: 'var(--ag-ink)',
                boxSizing: 'border-box',
                flexShrink: '0'
            }
        },
        label: { base: { textTransform: 'uppercase' } }
    },
    variants: { tone: toneInk() },
    modifiers: {
        // Idle states: nothing is happening, so the dot is a ring.
        hollow: { dot: { base: { background: 'transparent', border: '1.5px solid var(--ag-ink)' } } },
        // Tags: outline only, no fill, `line-strong` border, no dot.
        outline: {
            root: { base: { background: 'transparent', borderColor: 'var(--ag-line-strong)' } },
            dot: { base: { display: 'none' } },
            label: { base: { textTransform: 'none', letterSpacing: 'var(--tracking-normal)' } }
        }
    },
    defaultVariants: { tone: 'muted' }
};

/** Identity tile: square, radius 6, two-letter mono monogram; fill hue at 12 %, border at 40 %. */
const agentTile: RecipeInput = {
    component: 'ag-agent-tile',
    tokens: { '--ag-hue': 'var(--ag-text-muted)', '--ag-tile': '32px' },
    parts: {
        root: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                inlineSize: 'var(--ag-tile)',
                blockSize: 'var(--ag-tile)',
                borderRadius: 'var(--radius-field)',
                background: 'color-mix(in oklab, var(--ag-hue) 12%, transparent)',
                border: 'var(--border) solid color-mix(in oklab, var(--ag-hue) 40%, transparent)',
                color: 'var(--ag-hue)',
                flexShrink: '0',
                boxSizing: 'border-box'
            }
        },
        monogram: {
            base: {
                fontFamily: mono,
                fontWeight: 'var(--weight-semibold)',
                fontSize: 'calc(var(--ag-tile) * 0.34375)',
                lineHeight: 'var(--leading-none)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--tracking-normal)'
            }
        }
    },
    modifiers: {
        // People are circles on the raised surface: the shape is the only way to tell agent from user at 18 px.
        circle: {
            root: {
                base: {
                    borderRadius: '50%',
                    background: 'var(--color-base-300)',
                    borderColor: 'var(--ag-line-strong)',
                    color: 'var(--color-base-content)'
                }
            }
        }
    }
};

/** Environment line: mono 12, `text-dim` slashes, never wraps. */
const envLine: RecipeInput = {
    component: 'ag-env-line',
    tokens: { '--ag-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 'var(--space-xs)',
                fontFamily: mono,
                fontSize: 'var(--text-sm)',
                color: 'var(--ag-ink)',
                whiteSpace: 'nowrap',
                minInlineSize: '0',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
            }
        },
        machine: { base: { whiteSpace: 'nowrap' } },
        sep: { base: { color: 'var(--ag-text-dim)' } },
        runtime: { base: { whiteSpace: 'nowrap' } },
        account: { base: { whiteSpace: 'nowrap' } }
    },
    variants: {
        tone: {
            muted: { root: { base: { '--ag-ink': 'var(--ag-text-muted)' } } },
            dim: { root: { base: { '--ag-ink': 'var(--ag-text-dim)' } } },
            live: { root: { base: { '--ag-ink': 'var(--color-base-content)' } } },
            working: { root: { base: { '--ag-ink': 'var(--color-info)' } } },
            'needs-you': { root: { base: { '--ag-ink': 'var(--color-warning)' } } },
            failed: { root: { base: { '--ag-ink': 'var(--color-error)' } } }
        }
    },
    defaultVariants: { tone: 'muted' }
};

/** Needs-you row: card on base-200, tile 32 top-aligned, kind pill + title 14 / 600, context 12, action row. */
const needsItem: RecipeInput = {
    component: 'ag-needs-item',
    parts: {
        root: {
            base: {
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr)',
                columnGap: 'var(--space-md)',
                rowGap: 'var(--space-xs)',
                alignItems: 'start',
                padding: 'var(--space-lg)',
                border: 'var(--border) solid var(--ag-line)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                transition: `opacity ${motion}`
            }
        },
        tile: { base: { gridRow: '1 / span 3', display: 'inline-flex' } },
        head: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minInlineSize: '0', flexWrap: 'wrap' } },
        title: { base: { fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minInlineSize: '0' } },
        context: { base: { margin: '0', fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)', alignItems: 'baseline' } },
        actions: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', marginBlockStart: 'var(--space-xs)' } }
    },
    variants: {
        // The kind pill takes its meaning colour; the card stays neutral (colour only ever means state).
        kind: {
            approval: { root: { base: { '--ag-kind-ink': 'var(--color-warning)' } } },
            input: { root: { base: { '--ag-kind-ink': 'var(--color-warning)' } } },
            interrupted: { root: { base: { '--ag-kind-ink': 'var(--color-error)' } } }
        }
    },
    modifiers: {
        // Session page and mobile: no context line.
        compact: { context: { base: { display: 'none' } }, root: { base: { padding: 'var(--space-md)' } } }
    }
};

/** Task node: one 28 px rail column per depth with a `line-strong` left border; selected = base-300 + live border at 53 %. */
const taskNode: RecipeInput = {
    component: 'ag-task-node',
    tokens: { '--ag-depth': '0' },
    parts: {
        root: { base: { display: 'flex', alignItems: 'stretch', paddingInlineStart: 'calc(var(--ag-depth) * 28px)', minInlineSize: '0' } },
        rail: { base: { inlineSize: '28px', flexShrink: '0', borderInlineStart: 'var(--border) solid var(--ag-line-strong)', marginInlineStart: '-28px', marginInlineEnd: '0' } },
        card: {
            base: {
                flex: '1 1 auto',
                minInlineSize: '0',
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                gridTemplateAreas: '"tile title status" "tile meta status" "tile wait status"',
                columnGap: 'var(--space-md)',
                rowGap: 'var(--space-2xs)',
                alignItems: 'center',
                padding: 'var(--space-md)',
                border: 'var(--border) solid var(--ag-line)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                cursor: 'pointer',
                transition: `border-color ${motion}, background ${motion}`
            },
            states: { hover: { borderColor: 'var(--ag-line-strong)' }, 'focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '2px' } }
        },
        tile: { base: { gridArea: 'tile', display: 'inline-flex' } },
        title: { base: { gridArea: 'title', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        meta: { base: { gridArea: 'meta', display: 'flex', gap: 'var(--space-sm)', alignItems: 'baseline', fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)', minInlineSize: '0' } },
        wait: { base: { gridArea: 'wait', fontFamily: mono, fontSize: 'var(--text-sm)', color: 'var(--color-warning)' } },
        status: { base: { gridArea: 'status', display: 'inline-flex', alignSelf: 'start' } }
    },
    modifiers: {
        selected: {
            card: {
                base: {
                    background: 'var(--color-base-300)',
                    borderColor: 'color-mix(in oklab, var(--color-primary) 53%, transparent)'
                }
            }
        }
    }
};

/** Connection strip: a card at the sidebar foot, one row per signal — dot + name + mono state. */
const connection: RecipeInput = {
    component: 'ag-connection',
    tokens: { '--ag-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                listStyle: 'none',
                margin: '0',
                padding: 'var(--space-sm) var(--space-md)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-xs)',
                border: 'var(--border) solid var(--ag-line)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)'
            }
        },
        row: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontSize: 'var(--text-sm)', minInlineSize: '0' } },
        dot: { base: { inlineSize: '6px', blockSize: '6px', borderRadius: '50%', background: 'var(--ag-ink)', flexShrink: '0', boxSizing: 'border-box' } },
        name: { base: { flex: '1 1 auto', minInlineSize: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        state: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-ink)', whiteSpace: 'nowrap' } }
    },
    variants: { tone: toneInk('row') },
    modifiers: {
        hollow: { dot: { base: { background: 'transparent', border: '1.5px solid var(--ag-ink)' } } }
    }
};

/** Version item: a list row with version + date, the reason, and its actions; `current` marks the live one. */
const version: RecipeInput = {
    component: 'ag-version',
    parts: {
        root: {
            base: {
                listStyle: 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-xs)',
                padding: 'var(--space-md) var(--space-lg)',
                borderBlockEnd: 'var(--border) solid var(--ag-line)',
                color: 'var(--color-base-content)'
            },
            selectors: { '&:last-child': { borderBlockEnd: 'none' } }
        },
        head: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', fontFamily: mono } },
        meta: { base: { fontSize: 'var(--text-xs)', fontFamily: mono, color: 'var(--ag-text-dim)' } },
        reason: { base: { margin: '0', fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' } },
        actions: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', marginBlockStart: 'var(--space-2xs)' } }
    },
    variants: {
        tone: {
            'needs-you': { root: { base: { background: 'color-mix(in oklab, var(--color-warning) 6%, transparent)' } } }
        }
    },
    modifiers: {
        current: { root: { base: { background: 'var(--color-base-300)' } } }
    }
};

/** Environment card: base-200 box; the meter is one 18 × 6 segment per slot, `working` when used; auth failure paints the border. */
const envCard: RecipeInput = {
    component: 'ag-env-card',
    tokens: { '--ag-ink': 'var(--ag-line)' },
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-sm)',
                padding: 'var(--space-lg)',
                border: 'var(--border) solid var(--ag-line)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                transition: `border-color ${motion}, opacity ${motion}`
            }
        },
        header: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' } },
        name: { base: { margin: '0', fontFamily: mono, fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', flex: '1 1 auto', minInlineSize: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        status: { base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)', fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' } },
        line: { base: { margin: '0', fontFamily: mono, fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' } },
        capacity: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' } },
        meter: { base: { display: 'inline-flex', gap: '3px' } },
        slot: {
            base: { display: 'inline-block', inlineSize: '18px', blockSize: '6px', borderRadius: '2px', background: 'var(--ag-line-strong)' },
            selectors: { '&[data-used]': { background: 'var(--color-info)' } }
        },
        count: { base: { whiteSpace: 'nowrap' } },
        queued: { base: { color: 'var(--color-warning)', whiteSpace: 'nowrap' } },
        facts: {
            base: { margin: '0', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 'var(--space-md)', rowGap: 'var(--space-2xs)', fontSize: 'var(--text-sm)' },
            selectors: {
                '& > dt': { fontFamily: mono, fontSize: 'var(--text-xs)', letterSpacing: 'var(--tracking-wider)', textTransform: 'uppercase', color: 'var(--ag-text-dim)', alignSelf: 'baseline' },
                '& > dd': { margin: '0', color: 'var(--ag-text-muted)', overflowWrap: 'anywhere' }
            }
        },
        'default-for': { base: { display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' } },
        fix: { base: { margin: '0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-md)', fontSize: 'var(--text-sm)', color: 'var(--color-base-content)', paddingBlockStart: 'var(--space-sm)', borderBlockStart: 'var(--border) solid var(--ag-line)' } },
        actions: { base: { display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' } }
    },
    variants: {
        tone: {
            live: { root: { base: { borderColor: 'var(--ag-line)' } } },
            working: { root: { base: { borderColor: 'var(--ag-line)' } } },
            muted: { root: { base: { borderColor: 'var(--ag-line)' } } },
            dim: { root: { base: { borderColor: 'var(--ag-line)', opacity: '0.7' } } },
            'needs-you': { root: { base: { borderColor: 'var(--color-warning)' } } },
            failed: { root: { base: { borderColor: 'var(--color-error)' } } }
        }
    },
    modifiers: {
        selected: { root: { base: { borderColor: 'color-mix(in oklab, var(--color-primary) 53%, transparent)', background: 'var(--color-base-300)' } } }
    }
};

export const recipes: RecipeInput[] = [pill, agentTile, envLine, needsItem, taskNode, connection, version, envCard];
