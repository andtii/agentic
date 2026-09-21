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
        quota: { base: { paddingBlockStart: 'var(--space-sm)', borderBlockStart: 'var(--border) solid var(--ag-line)' } },
        fix: {
            base: { margin: '0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-md)', fontSize: 'var(--text-sm)', color: 'var(--color-base-content)', paddingBlockStart: 'var(--space-sm)', borderBlockStart: 'var(--border) solid var(--ag-line)' },
            // The line wraps; the button keeps its intrinsic width ("Re-check" never breaks).
            selectors: { '& > [data-scope="button"]': { flex: 'none' } }
        },
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

/** Failure card: base-200, border = the state ink at 33 %, radius 8, padding 16, gap 10; icon 16 and name 14 / 600 in the ink, mono signal, 13 px detail, one action (OPS-04). */
const failure: RecipeInput = {
    component: 'ag-failure',
    tokens: { '--ag-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                padding: 'var(--space-lg)',
                border: 'var(--border) solid color-mix(in oklab, var(--ag-ink) 33%, transparent)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                minInlineSize: '0'
            }
        },
        header: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minInlineSize: '0' } },
        icon: { base: { display: 'inline-flex', color: 'var(--ag-ink)', flexShrink: '0' } },
        name: { base: { fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', color: 'var(--ag-ink)', flex: '1 1 auto', minInlineSize: '0' } },
        signal: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap', marginInlineStart: 'auto' } },
        detail: { base: { margin: '0', fontSize: 'var(--text-md)', color: 'var(--ag-text-muted)', textWrap: 'pretty' } },
        actions: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' } }
    },
    variants: {
        // Six kinds, three inks: muted for the browser, amber where a person can act on the machine, red where work stopped.
        kind: {
            offline: { root: { base: { '--ag-ink': 'var(--ag-text-muted)' } } },
            machine: { root: { base: { '--ag-ink': 'var(--color-warning)' } } },
            auth: { root: { base: { '--ag-ink': 'var(--color-warning)' } } },
            runtime: { root: { base: { '--ag-ink': 'var(--color-error)' } } },
            task: { root: { base: { '--ag-ink': 'var(--color-error)' } } },
            interrupted: { root: { base: { '--ag-ink': 'var(--color-error)' } } }
        },
        tone: {
            muted: { root: { base: { '--ag-ink': 'var(--ag-text-muted)' } } },
            'needs-you': { root: { base: { '--ag-ink': 'var(--color-warning)' } } },
            failed: { root: { base: { '--ag-ink': 'var(--color-error)' } } }
        }
    }
};

/** Banner over the content: a full-width strip on base-200 with the ink's 33 % border, icon + text + mono state. */
const banner: RecipeInput = {
    component: 'ag-banner',
    tokens: { '--ag-ink': 'var(--ag-text-muted)' },
    parts: {
        root: {
            base: {
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-sm)',
                padding: 'var(--space-sm) var(--space-lg)',
                border: 'var(--border) solid color-mix(in oklab, var(--ag-ink) 33%, transparent)',
                borderRadius: 'var(--radius-box)',
                background: 'color-mix(in oklab, var(--ag-ink) 6%, var(--color-base-200))',
                color: 'var(--color-base-content)',
                fontSize: 'var(--text-md)'
            }
        },
        icon: { base: { display: 'inline-flex', color: 'var(--ag-ink)', flexShrink: '0' } },
        text: { base: { fontWeight: 'var(--weight-semibold)', color: 'var(--ag-ink)' } },
        state: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', marginInlineStart: 'auto', whiteSpace: 'nowrap' } },
        actions: { base: { display: 'inline-flex', gap: 'var(--space-sm)' } }
    },
    variants: {
        tone: {
            muted: { root: { base: { '--ag-ink': 'var(--ag-text-muted)' } } },
            'needs-you': { root: { base: { '--ag-ink': 'var(--color-warning)' } } },
            failed: { root: { base: { '--ag-ink': 'var(--color-error)' } } }
        }
    }
};

/** Empty state: a centred card on base-200 (dashed with `outline`), or one muted line with `compact`. */
const empty: RecipeInput = {
    component: 'ag-empty',
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 'var(--space-sm)',
                padding: 'var(--space-xl)',
                border: 'var(--border) solid var(--ag-line)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)'
            }
        },
        icon: { base: { display: 'inline-flex', color: 'var(--ag-text-muted)' } },
        title: { base: { fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-semibold)', lineHeight: 'var(--leading-tight)' } },
        caption: { base: { margin: '0', fontSize: 'var(--text-md)', color: 'var(--ag-text-muted)', textWrap: 'pretty' } },
        actions: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', marginBlockStart: 'var(--space-xs)' } }
    },
    modifiers: {
        compact: { root: { base: { padding: '0', border: 'none', background: 'transparent' } } },
        outline: { root: { base: { borderStyle: 'dashed', borderColor: 'var(--ag-line-strong)', background: 'transparent' } } }
    }
};

const ring = { outline: '2px solid var(--color-primary)', outlineOffset: '2px' };
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minInlineSize: '0' };
const bare = { appearance: 'none', border: 'none', background: 'transparent', font: 'inherit', textAlign: 'start', cursor: 'pointer' };

/** Working folder field (#191): a read-only chip like an input (mono 12 on base-100); compact = a 28 px chip button for a chat header. */
const workdir: RecipeInput = {
    component: 'ag-workdir',
    parts: {
        root: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap', minInlineSize: '0' } },
        chip: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                flex: '1 1 12rem',
                minInlineSize: '0',
                minBlockSize: 'var(--ag-input-h)',
                padding: '0 var(--space-md)',
                boxSizing: 'border-box',
                border: 'var(--border) solid var(--ag-line-strong)',
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-100)',
                color: 'var(--color-base-content)',
                fontFamily: mono,
                fontSize: 'var(--text-sm)'
            },
            selectors: {
                '& > span': ellipsis,
                '& > svg': { color: 'var(--ag-text-dim)' },
                '&[data-empty]': { color: 'var(--ag-text-dim)' }
            }
        },
        actions: { base: { display: 'inline-flex', gap: 'var(--space-sm)', flex: 'none' } }
    },
    modifiers: {
        // A chat header: the chip alone, as the button.
        compact: {
            chip: {
                base: { ...bare, fontFamily: mono, fontSize: 'var(--text-sm)', flex: '0 1 auto', minBlockSize: '28px', padding: '0 var(--space-sm)', maxInlineSize: '100%', border: 'var(--border) solid var(--ag-line-strong)', borderRadius: 'var(--radius-selector)', background: 'var(--color-base-200)', color: 'var(--ag-text-muted)' },
                selectors: {
                    '&:hover:not(:disabled)': { borderColor: 'var(--ag-text-dim)', color: 'var(--color-base-content)' },
                    '&:focus-visible': ring,
                    '&:disabled': { opacity: 'var(--disabled-opacity)', cursor: 'not-allowed' }
                }
            }
        }
    }
};

/** The folder picker (#191): environment strip, Recent / Roots, breadcrumb bar, the folder listbox on base-100, notices, the worktree form. */
const workdirPicker: RecipeInput = {
    component: 'ag-workdir-picker',
    parts: {
        root: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', minInlineSize: '0', color: 'var(--color-base-content)', fontSize: 'var(--text-md)' } },
        envs: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' } },
        env: {
            base: {
                ...bare,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2xs)',
                maxInlineSize: '100%',
                minInlineSize: '0',
                padding: 'var(--space-sm) var(--space-md)',
                border: 'var(--border) solid var(--ag-line-strong)',
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                transition: `border-color ${motion}, background ${motion}`
            },
            selectors: {
                '&:hover:not(:disabled)': { borderColor: 'var(--ag-text-dim)' },
                '&:focus-visible': ring,
                '&[aria-pressed="true"]': { background: 'var(--color-base-300)', borderColor: 'color-mix(in oklab, var(--color-primary) 53%, transparent)' },
                // Disabled keeps its reason readable: dashed, not faded.
                '&:disabled': { cursor: 'not-allowed', borderStyle: 'dashed', background: 'transparent' }
            }
        },
        'env-name': { base: { ...ellipsis, maxInlineSize: '100%', fontFamily: mono, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' } },
        'env-note': {
            base: { fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' },
            selectors: { '[data-unavailable] > &': { color: 'var(--color-warning)' } }
        },
        section: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' } },
        heading: { base: { margin: '0', fontFamily: mono, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)', letterSpacing: 'var(--tracking-wider)', textTransform: 'uppercase', color: 'var(--ag-text-dim)' } },
        shortcuts: { base: { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: 'var(--space-2xs)' } },
        shortcut: {
            base: { ...bare, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', inlineSize: '100%', padding: 'var(--space-xs) var(--space-sm)', borderRadius: 'var(--radius-field)', color: 'var(--color-base-content)', fontFamily: mono, fontSize: 'var(--text-sm)' },
            selectors: { '& > span': ellipsis, '& > svg': { color: 'var(--ag-text-dim)' }, '&:hover': { background: 'var(--color-base-200)' }, '&:focus-visible': ring }
        },
        bar: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap', minInlineSize: '0' } },
        crumbs: {
            base: { flex: '1 1 12rem', minInlineSize: '0' },
            selectors: {
                '& > ol': { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2xs)' },
                '& li': { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)', minInlineSize: '0', color: 'var(--ag-text-dim)' }
            }
        },
        crumb: {
            base: { ...bare, padding: '2px var(--space-2xs)', borderRadius: 'var(--radius-selector)', maxInlineSize: '100%', overflowWrap: 'anywhere', fontFamily: mono, fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' },
            selectors: { '&:hover': { color: 'var(--color-base-content)' }, '&[aria-current]': { color: 'var(--color-base-content)', fontWeight: 'var(--weight-semibold)' }, '&:focus-visible': ring }
        },
        editor: {
            base: { flex: '1 1 100%', display: 'flex', alignItems: 'flex-end', gap: 'var(--space-sm)', flexWrap: 'wrap', minInlineSize: '0' },
            selectors: { '& > [data-scope="field"]': { flex: '1 1 14rem', minInlineSize: '0' } }
        },
        list: {
            base: { listStyle: 'none', margin: '0', padding: 'var(--space-xs)', maxBlockSize: 'min(50vh, 22rem)', overflowY: 'auto', overscrollBehavior: 'contain', border: 'var(--border) solid var(--ag-line)', borderRadius: 'var(--radius-box)', background: 'var(--color-base-100)', transition: `opacity ${motion}` },
            selectors: { '&:focus-visible': ring }
        },
        item: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minInlineSize: '0', padding: 'var(--space-xs) var(--space-sm)', borderRadius: 'var(--radius-field)', color: 'var(--ag-text-muted)', cursor: 'pointer' },
            selectors: { '&:hover': { background: 'var(--color-base-200)' }, '&[aria-selected="true"]': { background: 'var(--color-base-300)', color: 'var(--color-base-content)' }, '& > svg': { color: 'var(--ag-text-dim)' } }
        },
        name: { base: { ...ellipsis, flex: '1 1 auto', fontFamily: mono, fontSize: 'var(--text-sm)' } },
        notice: {
            base: { margin: '0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-md)', flexWrap: 'wrap', padding: 'var(--space-sm) var(--space-md)', border: 'var(--border) solid var(--ag-line)', borderRadius: 'var(--radius-box)', color: 'var(--ag-text-muted)' },
            selectors: {
                '&[data-notice="error"]': { color: 'var(--color-error)', borderColor: 'color-mix(in oklab, var(--color-error) 40%, transparent)' },
                '&[data-notice="offline"]': { color: 'var(--color-warning)', borderColor: 'color-mix(in oklab, var(--color-warning) 40%, transparent)' },
                '&[data-notice="truncated"]': { padding: '0', border: 'none', fontSize: 'var(--text-sm)', color: 'var(--ag-text-dim)' }
            }
        },
        worktree: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', padding: 'var(--space-lg)', border: 'var(--border) solid var(--ag-line-strong)', borderRadius: 'var(--radius-box)', background: 'var(--color-base-200)' } },
        actions: { base: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-sm)', flexWrap: 'wrap' } }
    },
    modifiers: {
        // A move in flight: the stale listing stays, dimmed.
        loading: { list: { base: { opacity: '0.55' } } }
    }
};

/** Plugin card (#232): the env card's box at the handoff's card padding; name mono 15 / 600 with a dim version, tags in a row, the footer pinned to the bottom of a grid row. */
const pluginCard: RecipeInput = {
    component: 'ag-plugin-card',
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 'var(--space-md)',
                minInlineSize: '0',
                padding: 'var(--space-xl)',
                border: 'var(--border) solid var(--ag-line)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                transition: `border-color ${motion}, opacity ${motion}`
            }
        },
        header: { base: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-md)', alignSelf: 'stretch', minInlineSize: '0' } },
        name: { base: { margin: '0', display: 'inline-flex', alignItems: 'baseline', gap: 'var(--space-sm)', minInlineSize: '0', fontFamily: mono, fontSize: '15px', fontWeight: 'var(--weight-semibold)' }, selectors: { '& > span:first-child': ellipsis } },
        version: { base: { flex: 'none', fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-dim)' } },
        tags: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' } },
        readiness: { base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap', fontSize: 'var(--text-sm)' } },
        'readiness-detail': { base: { color: 'var(--ag-text-muted)' } },
        description: { base: { margin: '0', fontSize: 'var(--text-md)', color: 'var(--ag-text-muted)' } },
        footer: { base: { marginBlockStart: 'auto', paddingBlockStart: 'var(--space-sm)', alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-md)', flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' } },
        meta: { base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)', flexWrap: 'wrap', minInlineSize: '0' } }
    },
    variants: {
        tone: {
            dim: { root: { base: { color: 'var(--ag-text-muted)' } } },
            'needs-you': { root: { base: { borderColor: 'color-mix(in oklab, var(--color-warning) 53%, transparent)' } } },
            failed: { root: { base: { borderColor: 'var(--color-error)' } } }
        }
    },
    modifiers: {
        selected: { root: { base: { borderColor: 'color-mix(in oklab, var(--color-primary) 53%, transparent)' } } }
    }
};

/** Secret field (#232): the state row (pill, then Replace / Remove), and the editor — the input takes the row, the buttons keep their width. */
const secret: RecipeInput = {
    component: 'ag-secret',
    parts: {
        root: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', minInlineSize: '0' } },
        state: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' } },
        actions: { base: { display: 'inline-flex', gap: 'var(--space-sm)', flexWrap: 'wrap' } },
        editor: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap', margin: '0', minInlineSize: '0' },
            selectors: { '& > [data-scope="input"]': { flex: '1 1 14rem', minInlineSize: '0' }, '& > [data-scope="button"]': { flex: 'none' } }
        }
    }
};

/** Map field (#232): name and value share the row evenly, the remove button keeps its square; a narrow row wraps. */
const mapField: RecipeInput = {
    component: 'ag-map-field',
    parts: {
        root: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', minInlineSize: '0' } },
        row: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap', minInlineSize: '0' },
            selectors: { '& > [data-scope="input"]': { flex: '1 1 9rem', minInlineSize: '0' }, '& > [data-scope="button"]': { flex: 'none' } }
        },
        actions: { base: { display: 'flex' } }
    }
};

/** A limit window, like Claude Code's `/usage`: label over a full-width 8 px bar with the percent beside it, the reset line under; the bar is the status ink. */
const quota: RecipeInput = {
    component: 'ag-quota',
    tokens: { '--ag-ink': 'var(--color-primary)' },
    parts: {
        root: { base: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', columnGap: 'var(--space-md)', rowGap: 'var(--space-2xs)', transition: `opacity ${motion}` } },
        label: { base: { gridColumn: '1 / -1', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--color-base-content)' } },
        bar: { base: { display: 'block', blockSize: '8px', borderRadius: 'var(--radius-selector)', background: 'var(--ag-line-strong)', overflow: 'hidden' } },
        fill: { base: { display: 'block', blockSize: '100%', background: 'var(--ag-ink)', borderRadius: 'inherit', transition: `inline-size ${motion}` } },
        used: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-muted)', whiteSpace: 'nowrap' } },
        resets: { base: { gridColumn: '1 / -1', fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)' } }
    },
    variants: {
        tone: {
            muted: { root: { base: { '--ag-ink': 'var(--ag-text-dim)' } } },
            live: { root: { base: { '--ag-ink': 'var(--color-primary)' } } },
            'needs-you': { root: { base: { '--ag-ink': 'var(--color-warning)' } } },
            failed: { root: { base: { '--ag-ink': 'var(--color-error)' } } }
        }
    },
    modifiers: {
        stale: { root: { base: { opacity: '0.6' } } },
        // One line (#315): label, a 56 px bar, the percent; the reset time is the tooltip.
        compact: {
            root: { base: { display: 'inline-grid', gridTemplateColumns: 'minmax(0, auto) 56px auto', columnGap: 'var(--space-sm)', maxInlineSize: '100%' } },
            label: { base: { gridColumn: 'auto', fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-normal)', color: 'var(--ag-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            bar: { base: { blockSize: '6px' } }
        }
    }
};

/** An account's limits: a header (title, plan tag, age) over the windows, 12 px apart; the age turns warning when stale. */
const quotaPanel: RecipeInput = {
    component: 'ag-quota-panel',
    parts: {
        root: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', minInlineSize: '0' } },
        header: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' } },
        title: { base: { fontFamily: mono, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', flex: '1 1 auto', minInlineSize: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        age: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' } },
        // The zone the short reset lines are in (#452), once, at the header's end.
        zone: { base: { marginInlineStart: 'auto', fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' } },
        reason: { base: { margin: '0', fontSize: 'var(--text-sm)', color: 'var(--ag-text-muted)' } }
    },
    modifiers: {
        stale: { age: { base: { color: 'var(--color-warning)' } } },
        compact: { root: { base: { gap: 'var(--space-xs)' } } }
    }
};

/**
 * A member's limits as rings (#452): a 28 px ring per window, its arc the status ink over a line-coloured track, the
 * mono percent over a small uppercase label beside it; the rings share one row (#470). A reached limit is amber like
 * the card's limit line, its percent too.
 */
const quotaRings: RecipeInput = {
    component: 'ag-quota-rings',
    parts: {
        root: { base: { display: 'flex', alignItems: 'center', flexWrap: 'nowrap', justifyContent: 'space-between', gap: 'var(--space-sm)', inlineSize: '100%', minInlineSize: '0', transition: `opacity ${motion}` } },
        item: {
            // The ring on the left across both rows, the percent over the label beside it.
            base: { '--ag-ink': 'var(--color-primary)', display: 'grid', gridTemplateColumns: '28px auto', gridTemplateRows: 'auto auto', columnGap: 'var(--space-xs)', alignItems: 'center', minInlineSize: '0' },
            selectors: {
                '&[data-tone="muted"]': { '--ag-ink': 'var(--ag-text-dim)' },
                '&[data-tone="needs-you"]': { '--ag-ink': 'var(--color-warning)' },
                '&[data-tone="failed"]': { '--ag-ink': 'var(--color-warning)' },
                '&[data-status="exhausted"] > [data-part="value"], &[data-status="exhausted"] > [data-part="label"]': { color: 'var(--color-warning)' }
            }
        },
        ring: {
            base: { gridRow: '1 / span 2', inlineSize: '28px', blockSize: '28px', transform: 'rotate(-90deg)' },
            selectors: {
                '& > circle': { fill: 'none', strokeWidth: '3' },
                '& > [data-track]': { stroke: 'var(--ag-line-strong)' },
                '& > [data-arc]': { stroke: 'var(--ag-ink)', strokeLinecap: 'round', transition: `stroke-dasharray ${motion}` }
            }
        },
        value: { base: { gridColumn: '2', alignSelf: 'end', lineHeight: '1.1', fontFamily: mono, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--color-base-content)', whiteSpace: 'nowrap' } },
        label: { base: { gridColumn: '2', alignSelf: 'start', lineHeight: '1.1', fontFamily: mono, fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ag-text-dim)', whiteSpace: 'nowrap' } }
    },
    modifiers: {
        stale: { root: { base: { opacity: '0.6' } } }
    }
};

export const recipes: RecipeInput[] = [pill, agentTile, envLine, needsItem, taskNode, connection, version, envCard, failure, banner, empty, workdir, workdirPicker, pluginCard, secret, mapField, quota, quotaPanel, quotaRings];
