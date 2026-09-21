/**
 * The recipe pack — the six `ai-*` scopes styled to `docs/design/HANDOFF.md`
 * → "`ai-*` fragment", "Tool call `data-state`", "Approvals", "Motion".
 *
 * Written against the RECOMMENDED token grammar (`var(--color-primary)`,
 * `var(--space-sm)`, `var(--radius-box)`); the handoff's own inks
 * (`--ag-text-dim`, `--ag-line`, …) are read WITH a recommended fallback,
 * so a skin keeping the recommended vocabulary adopts the pack as is (the
 * kit's validator warns on the undeclared token and moves on), and the
 * `agentic` design system, which declares them, paints the handoff exactly.
 * State colour rides the governed `data-state` and nested kit scopes (the
 * pill, the tile, the environment line) — never a `tone` axis of its own,
 * so the pack stays generic. Every declared state is styled distinctly: the
 * kit's state-legibility guard measures ink, and a tool card that looks the
 * same running and denied says nothing.
 *
 * Pure data: the kit import is type-only, the anatomy imports pull no
 * component code, so a design system's Node build script imports this entry
 * without loading the sigx runtime.
 */
import type { RecipeInput } from '@sigx/zero-kit';
import { RECOMMENDED_ROLE_LIST } from '@sigx/zero/contract';

const motion = 'var(--duration-fast) var(--ease-standard)';
const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
/** The handoff inks, with the recommended fallback a generic skin renders. */
const line = 'var(--ag-line, var(--color-base-300))';
const lineStrong = 'var(--ag-line-strong, var(--color-base-300))';
const textMuted = 'var(--ag-text-muted, var(--color-base-content))';
const textDim = 'var(--ag-text-dim, var(--color-base-content))';
const linkHover = 'var(--ag-link-hover, var(--color-primary))';
const controlTouch = 'var(--ag-control-h-touch, 2.75rem)';

/**
 * The lifecycle ink per governed state, and the border that only `active`
 * (RUNNING, `info`) and `error` (ERROR, `error`) take — the handoff's rule.
 * `loading` and `closed` keep the quiet line; `complete` too, so finished
 * work recedes. Every state still differs: the ink paints the icon.
 */
const lifecycle = {
    loading: { borderColor: line, '--ai-ink': textMuted },
    active: { borderColor: 'var(--color-info)', '--ai-ink': 'var(--color-info)' },
    complete: { borderColor: line, '--ai-ink': textMuted, opacity: '1' },
    error: { borderColor: 'var(--color-error)', '--ai-ink': 'var(--color-error)' },
    closed: { borderColor: line, '--ai-ink': 'var(--color-error)', opacity: '0.85' }
};

/** The 1200 ms opacity pulse a running or streaming dot carries, off under reduced motion. */
const pulse = {
    animation: 'ai-pulse 1200ms ease-in-out infinite'
};

const thread: RecipeInput = {
    component: 'ai-thread',
    parts: {
        root: {
            base: {
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2xl)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                paddingInline: 'var(--space-2xl)',
                paddingBlock: 'var(--space-2xl)',
                background: 'var(--color-base-100)',
                color: 'var(--color-base-content)'
            },
            states: {
                on: { scrollBehavior: 'smooth' },
                off: { scrollBehavior: 'auto' }
            },
            at: { 'reduced-motion': { base: { scrollBehavior: 'auto' } } }
        },
        // The centred "Showing the last N entries · Load earlier" chip.
        earlier: {
            base: {
                alignSelf: 'center',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                appearance: 'none',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-selector)',
                background: 'var(--color-base-200)',
                color: textMuted,
                fontSize: 'var(--text-sm)',
                paddingInline: 'var(--space-md)',
                paddingBlock: 'var(--space-xs)',
                cursor: 'pointer'
            },
            selectors: {
                '& > u': { color: 'var(--color-primary)', textDecoration: 'underline' },
                '&:hover > u': { color: linkHover },
                '&:focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '2px' }
            }
        },
        list: {
            base: { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: 'var(--space-2xl)' }
        },
        row: { base: { display: 'block' } },
        anchor: {
            base: {
                position: 'sticky',
                bottom: 'var(--space-sm)',
                alignSelf: 'center',
                appearance: 'none',
                border: 'none',
                borderRadius: 'var(--radius-selector)',
                background: 'var(--color-primary)',
                color: 'var(--color-primary-content)',
                fontSize: 'var(--text-sm)',
                fontWeight: 'var(--weight-semibold, 600)',
                paddingInline: 'var(--space-md)',
                paddingBlock: 'var(--space-xs)',
                boxShadow: 'var(--shadow-md)',
                cursor: 'pointer',
                transition: `opacity ${motion}`
            },
            // `on` is hidden by the runtime (`hiddenIn`), so the two states are
            // legitimately CSS-identical; `off` is the one that paints.
            states: { on: {}, off: { opacity: '1' } },
            selectors: { '&:hover': { background: linkHover } }
        }
    }
};

/** Row, gap 12, tile 32 top-aligned; meta line 13/600 name, dim env line, mono 11 time; body 14/1.6; tools gap 8. */
const message: RecipeInput = {
    component: 'ai-message',
    parts: {
        root: {
            base: {
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr)',
                gridTemplateAreas: '"avatar meta" "avatar body" "avatar tools" "avatar footer"',
                columnGap: 'var(--space-md)',
                rowGap: 'var(--space-xs)',
                alignItems: 'start',
                color: 'var(--color-base-content)'
            },
            selectors: {
                // The user's own rows read the same; the placement is there for a skin that wants a side.
                '&[data-placement="end"]': { marginInlineStart: '0' },
                '&[data-placement="start"]': { marginInlineEnd: '0' }
            }
        },
        avatar: { base: { gridArea: 'avatar', display: 'inline-flex', paddingBlockStart: 'var(--space-2xs)' } },
        meta: {
            base: {
                gridArea: 'meta',
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 'var(--space-sm)',
                minBlockSize: '1.25rem',
                fontSize: 'var(--text-md)'
            }
        },
        name: { base: { fontWeight: 'var(--weight-semibold, 600)' } },
        environment: { base: { display: 'inline-flex', minInlineSize: '0', color: textDim } },
        time: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim } },
        body: {
            base: {
                gridArea: 'body',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-sm)',
                fontSize: 'var(--text-lg)',
                lineHeight: '1.6',
                textWrap: 'pretty',
                minInlineSize: '0'
            }
        },
        // An image part: a thumbnail at most 320 px on its long edge, full size one click away.
        image: {
            base: {
                display: 'inline-flex',
                alignSelf: 'flex-start',
                maxInlineSize: 'min(100%, 20rem)',
                overflow: 'hidden',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)'
            },
            selectors: {
                '& > img': { display: 'block', maxInlineSize: '100%', maxBlockSize: '20rem', objectFit: 'contain' },
                '&:focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '2px' }
            }
        },
        // A file part: a download chip — icon, name, dim mono size.
        file: {
            base: {
                display: 'inline-flex',
                alignSelf: 'flex-start',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                maxInlineSize: '100%',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-xs)',
                border: `var(--border) solid ${lineStrong}`,
                borderRadius: 'var(--radius-selector)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                fontSize: 'var(--text-md)',
                textDecoration: 'none'
            },
            selectors: {
                '&:hover': { borderColor: linkHover },
                '&:focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '2px' }
            }
        },
        'file-name': { base: { minInlineSize: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        'file-size': { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, whiteSpace: 'nowrap' } },
        tools: { base: { gridArea: 'tools', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', minInlineSize: '0' } },
        footer: { base: { gridArea: 'footer', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim } }
    }
};

/** Card base-200, radius 8, padding 10/12; header icon 15 + mono name + truncated signature + meta + pill; output well base-100. */
const toolCall: RecipeInput = {
    component: 'ai-tool-call',
    tokens: { '--ai-ink': textMuted },
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-sm)',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                paddingInline: 'var(--space-md)',
                paddingBlock: 'var(--space-sm)',
                fontSize: 'var(--text-sm)',
                minInlineSize: '0',
                transition: `border-color ${motion}`
            },
            states: lifecycle,
            // The running pill's dot pulses; still under reduced motion.
            selectors: { '&[data-state="active"] [data-scope="ag-pill"][data-part="dot"]': pulse },
            at: { 'reduced-motion': { selectors: { '&[data-state="active"] [data-scope="ag-pill"][data-part="dot"]': { animation: 'none' } } } }
        },
        header: {
            base: {
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-sm)',
                minInlineSize: '0'
            }
        },
        icon: { base: { display: 'inline-flex', flexShrink: '0', color: 'var(--ai-ink)' } },
        name: { base: { fontFamily: mono, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold, 600)', flexShrink: '0' } },
        signature: {
            base: {
                fontFamily: mono,
                fontSize: 'var(--text-sm)',
                color: textMuted,
                minInlineSize: '0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: '1 1 auto'
            }
        },
        meta: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, whiteSpace: 'nowrap', flexShrink: '0', marginInlineStart: 'auto' } },
        status: { base: { display: 'inline-flex', flexShrink: '0', marginInlineStart: 'auto' }, selectors: { '[data-part="meta"] + &': { marginInlineStart: '0' } } },
        input: {
            base: { fontFamily: mono, fontSize: 'var(--text-sm)', color: textMuted },
            states: { open: { color: 'var(--color-base-content)' }, closed: { opacity: '0.9' } },
            selectors: {
                '& > summary': { cursor: 'pointer', fontSize: 'var(--text-xs)', color: textDim, textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide, 0.08em)' },
                '& > pre': {
                    margin: 'var(--space-xs) 0 0',
                    padding: 'var(--space-sm) var(--space-md)',
                    border: `var(--border) solid ${line}`,
                    borderRadius: 'var(--radius-field)',
                    background: 'var(--color-base-100)',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere'
                }
            }
        },
        // The output well: base-100, mono 12, pre-wrap; folded past six lines.
        output: {
            base: { fontFamily: mono, fontSize: 'var(--text-sm)' },
            states: { open: { color: 'var(--color-base-content)' }, closed: { opacity: '0.9' } },
            selectors: {
                '& > summary': { cursor: 'pointer', fontSize: 'var(--text-xs)', color: textDim, textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide, 0.08em)' },
                '& > pre': {
                    margin: 'var(--space-xs) 0 0',
                    padding: 'var(--space-sm) var(--space-md)',
                    border: `var(--border) solid ${line}`,
                    borderRadius: 'var(--radius-field)',
                    background: 'var(--color-base-100)',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere'
                }
            }
        },
        more: {
            base: {
                appearance: 'none',
                border: 'none',
                background: 'transparent',
                padding: 'var(--space-xs) 0 0',
                fontFamily: mono,
                fontSize: 'var(--text-xs)',
                color: 'var(--color-primary)',
                cursor: 'pointer'
            },
            selectors: { '&:hover': { color: linkHover }, '&:focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '2px' } }
        },
        log: {
            base: { display: 'inline-block', paddingBlockStart: 'var(--space-xs)', fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--color-primary)' },
            selectors: { '&:hover': { color: linkHover } }
        },
        error: { base: { margin: '0', fontFamily: mono, fontSize: 'var(--text-sm)', color: 'var(--color-error)', overflowWrap: 'anywhere' } },
        agent: {
            base: {
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-box)',
                paddingInline: 'var(--space-md)',
                paddingBlock: 'var(--space-sm)',
                marginBlockStart: 'var(--space-xs)'
            },
            states: lifecycle
        }
    }
};

/** Collapsed by default: chevron 14 + "Reasoning · 6s" in text-dim; the chevron turns while open. */
const reasoning: RecipeInput = {
    component: 'ai-reasoning',
    parts: {
        root: {
            base: {
                color: 'var(--color-base-content)',
                fontSize: 'var(--text-md)'
            },
            states: { open: { paddingBlockEnd: 'var(--space-2xs)' }, closed: { opacity: '0.95' } }
        },
        summary: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-sm)',
                cursor: 'pointer',
                listStyle: 'none',
                color: textDim,
                fontSize: 'var(--text-md)',
                transition: `color ${motion}`
            },
            selectors: {
                '&::-webkit-details-marker': { display: 'none' },
                '&:hover': { color: textMuted },
                '& > svg': { transition: `transform ${motion}` },
                '[data-state="open"] > & > svg': { transform: 'rotate(90deg)' }
            },
            at: { 'reduced-motion': { selectors: { '& > svg': { transition: 'none' } } } }
        },
        body: { base: { paddingBlockStart: 'var(--space-sm)', paddingInlineStart: 'calc(14px + var(--space-sm))', color: textMuted, fontSize: 'var(--text-lg)', lineHeight: '1.6' } }
    }
};

/** The approval card: warning tint 6 % / border 40 %, radius 8, padding 14, gap 12; 96 px label column; 40 px actions. */
const approval: RecipeInput = {
    component: 'ai-approval',
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-md)',
                border: 'var(--border) solid color-mix(in oklab, var(--color-warning) 40%, transparent)',
                borderRadius: 'var(--radius-box)',
                background: 'color-mix(in oklab, var(--color-warning) 6%, transparent)',
                color: 'var(--color-base-content)',
                padding: 'var(--space-lg)',
                minInlineSize: '0',
                // The 180 ms collapse to the record, on the design system's normal step.
                transition: 'padding var(--duration-normal) ease-out, gap var(--duration-normal) ease-out'
            },
            at: { 'reduced-motion': { base: { transition: 'none' } } }
        },
        header: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color: 'var(--color-warning)' } },
        title: { base: { fontWeight: 'var(--weight-semibold, 600)', fontSize: 'var(--text-lg)' } },
        rule: { base: { marginInlineStart: 'auto', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, whiteSpace: 'nowrap' } },
        plan: {
            base: {
                padding: 'var(--space-sm) var(--space-md)',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-100)',
                maxBlockSize: '24rem',
                overflow: 'auto',
                fontSize: 'var(--text-sm)'
            }
        },
        request: {
            base: {
                display: 'flex',
                gap: 'var(--space-md)',
                padding: 'var(--space-sm) var(--space-md)',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-100)',
                fontFamily: mono,
                fontSize: 'var(--text-sm)',
                color: 'var(--color-base-content)',
                overflowWrap: 'anywhere'
            },
            selectors: { '& > code': { fontWeight: 'var(--weight-semibold, 600)', flexShrink: '0' } }
        },
        description: { base: { margin: '0', fontSize: 'var(--text-md)', color: textMuted } },
        context: {
            base: {
                display: 'grid',
                gridTemplateColumns: '6rem minmax(0, 1fr)',
                columnGap: 'var(--space-sm)',
                rowGap: 'var(--space-xs)',
                margin: '0',
                fontSize: 'var(--text-sm)',
                alignItems: 'center'
            },
            selectors: {
                '& > dt': { color: textDim },
                '& > dd': { margin: '0', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minInlineSize: '0', color: 'var(--color-base-content)' }
            }
        },
        actions: {
            base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' },
            selectors: { '& > [data-scope="button"]': { blockSize: '2.5rem' } }
        },
        'label-full': { base: { display: 'inline' } },
        'label-short': { base: { display: 'none' } },
        // The one-line record a decision collapses to.
        record: { base: { margin: '0', fontSize: 'var(--text-sm)', color: textMuted } }
    },
    modifiers: {
        // Session page and mobile: no context rows.
        compact: { context: { base: { display: 'none' } } }
    }
};

/** The approval card's frame in the `info` ink — a question waits on a person too, but gates nothing; options are toggles, `on` in the live ink. */
const question: RecipeInput = {
    component: 'ai-question',
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-md)',
                border: 'var(--border) solid color-mix(in oklab, var(--color-info) 40%, transparent)',
                borderRadius: 'var(--radius-box)',
                background: 'color-mix(in oklab, var(--color-info) 6%, transparent)',
                color: 'var(--color-base-content)',
                padding: 'var(--space-lg)',
                minInlineSize: '0'
            }
        },
        header: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color: 'var(--color-info)' } },
        title: { base: { fontWeight: 'var(--weight-semibold, 600)', fontSize: 'var(--text-lg)' } },
        // The asker stopped waiting (#285): what answering does now.
        note: { base: { margin: '0', fontSize: 'var(--text-sm)', color: textMuted, overflowWrap: 'anywhere' } },
        question: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', margin: '0', padding: '0', border: '0', minInlineSize: '0' } },
        label: { base: { padding: '0', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, textTransform: 'uppercase', letterSpacing: '0.04em' } },
        prompt: { base: { margin: '0', fontSize: 'var(--text-md)', color: 'var(--color-base-content)', overflowWrap: 'anywhere' } },
        options: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' } },
        option: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '2px',
                padding: 'var(--space-sm) var(--space-md)',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-100)',
                color: 'var(--color-base-content)',
                font: 'inherit',
                fontSize: 'var(--text-sm)',
                textAlign: 'start',
                cursor: 'pointer',
                transition: `border-color ${motion}, background ${motion}`
            },
            selectors: { '&:disabled': { cursor: 'default', opacity: '0.7' } },
            states: {
                on: { borderColor: 'var(--color-info)', background: 'color-mix(in oklab, var(--color-info) 14%, var(--color-base-100))' },
                off: { borderColor: line }
            }
        },
        hint: { base: { fontSize: 'var(--text-xs)', color: textMuted, overflowWrap: 'anywhere' } },
        other: {
            base: {
                boxSizing: 'border-box',
                inlineSize: '100%',
                minBlockSize: '56px',
                padding: 'var(--space-sm)',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-100)',
                color: 'var(--color-base-content)',
                font: 'inherit',
                fontSize: 'var(--text-sm)',
                resize: 'vertical'
            }
        },
        actions: {
            base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' },
            selectors: { '& > [data-scope="button"]': { blockSize: '2.5rem' } }
        },
        error: { base: { margin: '0', fontSize: 'var(--text-sm)', color: 'var(--color-error)' } },
        // The one-line record an answer collapses to.
        record: { base: { margin: '0', fontSize: 'var(--text-sm)', color: textMuted, overflowWrap: 'anywhere' } }
    }
};

/** Card base-200, `line-strong` border, radius 10; "To" row; borderless textarea 14; attach · key hint · Send 44. */
const composer: RecipeInput = {
    component: 'ai-composer',
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-sm)',
                border: `var(--border) solid ${lineStrong}`,
                borderRadius: 'var(--ag-radius-xl, var(--radius-box))',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                paddingInline: 'var(--space-lg)',
                paddingBlock: 'var(--space-md)'
            },
            selectors: {
                '&:focus-within': { borderColor: textDim }
            },
            // A drag carrying files hovers the card: the drop zone lights up.
            states: { highlighted: { borderColor: 'var(--color-primary)', borderStyle: 'dashed', background: 'var(--color-base-300)' } }
        },
        addressing: {
            base: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-sm)', fontSize: 'var(--text-sm)', color: textMuted }
        },
        recipient: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                paddingInline: 'var(--space-xs)',
                paddingBlock: 'var(--space-2xs)',
                border: `var(--border) solid ${lineStrong}`,
                borderRadius: 'var(--radius-selector)',
                background: 'var(--color-base-300)',
                color: 'var(--color-base-content)',
                fontSize: 'var(--text-sm)',
                fontWeight: 'var(--weight-semibold, 600)'
            },
            selectors: { '& > small': { fontFamily: mono, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-normal, 400)', color: textDim } }
        },
        hint: {
            base: { marginInlineStart: 'auto', fontSize: 'var(--text-sm)', color: textMuted },
            selectors: { '&[data-nobody]': { color: textDim } }
        },
        attachments: { base: { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)' } },
        attachment: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-xs)',
                borderRadius: 'var(--radius-selector)',
                border: `var(--border) solid ${lineStrong}`,
                background: 'var(--color-base-300)',
                fontFamily: mono,
                fontSize: 'var(--text-xs)',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-2xs)',
                maxInlineSize: '100%'
            },
            selectors: {
                // The remove control is chip-sized, not the 36 px icon button.
                '& > [data-scope="button"]': { inlineSize: '1.5rem', blockSize: '1.5rem', minBlockSize: '0', padding: '0' }
            },
            states: {
                loading: { color: textMuted },
                complete: {},
                error: { borderColor: 'var(--color-error)', color: 'var(--color-error)' }
            }
        },
        thumbnail: { base: { inlineSize: '1.5rem', blockSize: '1.5rem', objectFit: 'cover', borderRadius: 'var(--radius-selector)' } },
        'attachment-name': { base: { minInlineSize: '0', maxInlineSize: '14rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        'attachment-size': { base: { color: textDim } },
        // A 12 px ring that turns — the keyframes are in `fragmentCss`.
        spinner: {
            base: {
                display: 'inline-block',
                inlineSize: '0.75rem',
                blockSize: '0.75rem',
                border: '2px solid currentColor',
                borderInlineEndColor: 'transparent',
                borderRadius: '50%',
                animation: 'ai-spin 800ms linear infinite'
            }
        },
        'attachment-error': { base: { color: 'var(--color-error)' } },
        input: {
            base: { position: 'relative' },
            selectors: {
                // The field fills the card; its label is for assistive tech only (the card is the frame).
                '& [data-scope="textarea"][data-part="root"]': { display: 'flex', inlineSize: '100%' },
                '& [data-scope="textarea"][data-part="label"]': { position: 'absolute', inlineSize: '1px', blockSize: '1px', margin: '-1px', padding: '0', border: '0', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
                // Borderless, auto-growing, 14 px — the card is the frame.
                '& textarea': { display: 'block', inlineSize: '100%', boxSizing: 'border-box', border: 'none', background: 'transparent', boxShadow: 'none', padding: '0', fontSize: 'var(--text-lg)', lineHeight: '1.5', resize: 'none', outline: 'none' },
                '& textarea::placeholder': { color: textDim }
            }
        },
        // The mention popup: a listbox on base-300.
        mentions: {
            base: {
                position: 'absolute',
                insetBlockEnd: '100%',
                insetInlineStart: '0',
                listStyle: 'none',
                margin: '0 0 var(--space-xs)',
                padding: 'var(--space-xs)',
                minInlineSize: '12rem',
                border: `var(--border) solid ${lineStrong}`,
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-300)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: '1'
            },
            // `closed` is hidden by the runtime; `open` is the one that paints.
            states: { open: { display: 'block' }, closed: {} }
        },
        mention: {
            base: { paddingInline: 'var(--space-sm)', paddingBlock: 'var(--space-xs)', borderRadius: 'var(--radius-selector)', fontSize: 'var(--text-md)', cursor: 'pointer' },
            states: { highlighted: { background: 'var(--color-primary)', color: 'var(--color-primary-content)' } }
        },
        actions: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' },
            selectors: {
                '& > [data-scope="button"][data-intent="primary"]': { blockSize: controlTouch, paddingInline: 'var(--space-lg)' },
                '& > [data-scope="button"][data-intent="icon"]': { blockSize: controlTouch, inlineSize: controlTouch }
            }
        },
        keys: { base: { marginInlineStart: 'auto', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, whiteSpace: 'nowrap' } }
    }
};

/**
 * A `color` axis over the WHOLE recommended role list on the scopes whose
 * root paints a tint — a subset would diverge from every sibling component
 * in the adopting design system, and the kit's validator says so.
 */
function colorAxis(part: string, paint: (role: string) => Record<string, string>): NonNullable<RecipeInput['variants']> {
    return { color: Object.fromEntries(RECOMMENDED_ROLE_LIST.map((role) => [role, { [part]: { base: paint(role) } }])) };
}

thread.variants = colorAxis('anchor', (role) => ({ background: `var(--color-${role})`, color: `var(--color-${role}-content)` }));

/**
 * Raw CSS the design system appends verbatim: the keyframes the running dot
 * and the STREAMING pill pulse on, the attachment spinner's turn, and the phone regime recipes cannot
 * express (`docs/design/HANDOFF.md` → "Mobile specifics"): below 768 px the
 * composer docks to the bottom as one 48 px row (attach, single-line input
 * at 15 px, square Send) under the "To" row, the message meta drops the
 * environment line, and the approval card's `Allow once` takes a full row
 * with the other two answers sharing the next.
 */
export const fragmentCss = `@keyframes ai-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes ai-spin { to { transform: rotate(360deg); } }
[data-scope="ai-message"][data-part="meta"] [data-scope="ag-pill"][data-status="streaming"] [data-part="dot"] { animation: ai-pulse 1200ms ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
    [data-scope="ai-message"][data-part="meta"] [data-scope="ag-pill"][data-status="streaming"] [data-part="dot"] { animation: none; }
    [data-scope="ai-composer"][data-part="spinner"] { animation: none; }
}
@media (max-width: 767.98px) {
    [data-scope="ai-message"][data-part="environment"] { display: none; }

    [data-scope="ai-approval"][data-part="actions"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); }
    [data-scope="ai-approval"][data-part="label-full"] { display: none; }
    [data-scope="ai-approval"][data-part="label-short"] { display: inline; }
    [data-scope="ai-approval"][data-part="actions"] > [data-scope="button"] { block-size: var(--ag-control-h-touch); }
    [data-scope="ai-approval"][data-part="actions"] > :first-child { grid-column: 1 / -1; }

    [data-scope="ai-composer"][data-part="root"] {
        display: grid;
        grid-template-columns: var(--ag-control-h-touch) minmax(0, 1fr) var(--ag-control-h-touch);
        grid-template-areas: "to to to" "attachments attachments attachments" "attach input send" "cancel cancel cancel";
        align-items: end;
        gap: var(--space-sm);
        border-radius: 0;
        border-inline: 0;
        border-block-end: 0;
        border-block-start: var(--border) solid var(--ag-line);
        padding: var(--space-sm) var(--space-md) calc(var(--space-md) + env(safe-area-inset-bottom, 0px));
    }
    [data-scope="ai-composer"][data-part="addressing"] { grid-area: to; }
    [data-scope="ai-composer"][data-part="attachments"] { grid-area: attachments; }
    [data-scope="ai-composer"][data-part="input"] { grid-area: input; }
    [data-scope="ai-composer"][data-part="input"] textarea {
        box-sizing: border-box;
        min-block-size: var(--ag-control-h-touch);
        padding: 12px var(--space-md);
        border: var(--border) solid var(--ag-line-strong);
        border-radius: var(--radius-field);
        background: var(--color-base-100);
        font-size: 15px;
        line-height: 1.4;
    }
    [data-scope="ai-composer"][data-part="actions"] { display: contents; }
    [data-scope="ai-composer"][data-part="keys"] { display: none; }
    [data-scope="ai-composer"][data-part="actions"] > [data-scope="button"][data-intent="icon"] { grid-area: attach; inline-size: var(--ag-control-h-touch); block-size: var(--ag-control-h-touch); }
    [data-scope="ai-composer"][data-part="actions"] > [data-scope="button"][data-intent="default"] { grid-area: cancel; }
    [data-scope="ai-composer"][data-part="actions"] > [data-scope="button"][data-intent="primary"] {
        grid-area: send;
        inline-size: var(--ag-control-h-touch);
        block-size: var(--ag-control-h-touch);
        padding: 0;
        justify-content: center;
    }
    [data-scope="ai-composer"][data-part="actions"] > [data-scope="button"][data-intent="primary"] > span {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        margin: -1px;
        padding: 0;
        border: 0;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
}
`;

export const recipes: readonly RecipeInput[] = [thread, message, toolCall, reasoning, approval, question, composer];
