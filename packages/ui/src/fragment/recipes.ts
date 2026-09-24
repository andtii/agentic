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
 * The lifecycle ink per governed state, and the border that only `running`
 * (RUNNING, `info`) and `error` (ERROR, `error`) take — the handoff's rule.
 * `loading`, `denied` and `cancelled` keep the quiet line; `complete` too,
 * so finished work recedes to the look it had while queued. A `paused`
 * sub-agent is held, not moving: the live ink on a dashed line. `cancelled`
 * reads like `denied` — both are work that stopped short, and the pill says
 * which. The look-alike pairs are declared (`lifecycleSameAs`); every other
 * pair differs.
 */
const quiet = { borderColor: line, '--ai-ink': textMuted };
const refused = { borderColor: line, '--ai-ink': 'var(--color-error)', opacity: '0.85' };
const lifecycle = {
    loading: quiet,
    running: { borderColor: 'var(--color-info)', '--ai-ink': 'var(--color-info)' },
    paused: { borderColor: line, borderStyle: 'dashed', '--ai-ink': 'var(--color-info)' },
    complete: quiet,
    error: { borderColor: 'var(--color-error)', '--ai-ink': 'var(--color-error)' },
    denied: refused,
    cancelled: refused
};
const lifecycleSameAs = { complete: 'loading', cancelled: 'denied' };

const thread: RecipeInput = {
    component: 'ai-thread',
    // The anchor's `on` is hidden by the runtime (`hiddenIn`), so the two states look alike on purpose.
    sameAs: { anchor: { on: 'off', off: 'on' } },
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
                color: 'var(--color-base-content)',
                // Instant, never smooth (#495): a smooth pin animates the whole chat on open, and its in-between offsets read as a scroll up.
                scrollBehavior: 'auto'
            },
            // Following, the thread pins the bottom itself: the browser's scroll anchoring would move the offset up as the window slides, which reads as a scroll up. Paused, it keeps the reader's rows in place.
            states: {
                on: { overflowAnchor: 'none' },
                off: { overflowAnchor: 'auto' }
            }
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
        // Phones: the meta line drops the environment.
        environment: { base: { display: 'inline-flex', minInlineSize: '0', color: textDim }, at: { 'below-md': { base: { display: 'none' } } } },
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

/** The pre an input or output block shows: base-100, mono, pre-wrap. */
const well = {
    margin: '0',
    padding: 'var(--space-sm) var(--space-md)',
    border: `var(--border) solid ${line}`,
    borderRadius: 'var(--radius-field)',
    background: 'var(--color-base-100)',
    color: 'var(--color-base-content)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
};

/** The fold label on an input / output block: mono 11, uppercase, tracked. */
const foldTrigger = '& > [data-scope="collapsible"] > [data-scope="collapsible"][data-part="trigger"]';
const foldLabel = { fontFamily: mono, fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide, 0.08em)' };

/** Card base-200, radius 8, padding 10/12; header icon 15 + mono name + truncated signature + meta + pill; output well base-100. */
const toolCall: RecipeInput = {
    component: 'ai-tool-call',
    tokens: { '--ai-ink': textMuted },
    sameAs: { root: lifecycleSameAs, agent: lifecycleSameAs },
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
            // The running pill's dot pulses on its own: a `working` StatusPill is Badge.Dot in zero's `running` state.
            states: lifecycle
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
        meta: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, whiteSpace: 'nowrap', flexShrink: '0', marginInlineStart: 'auto' }, selectors: { '[data-part="link"] ~ &': { marginInlineStart: '0' } } },
        // "View diff": pushed right like the meta; whatever follows it keeps its place.
        link: {
            base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--color-primary)', whiteSpace: 'nowrap', flexShrink: '0', marginInlineStart: 'auto' },
            selectors: { '&:hover': { color: linkHover }, '[data-part="link"] ~ &': { marginInlineStart: '0' } }
        },
        status: { base: { display: 'inline-flex', flexShrink: '0', marginInlineStart: 'auto' }, selectors: { '[data-part="meta"] + &': { marginInlineStart: '0' }, '[data-part="link"] ~ &': { marginInlineStart: '0' } } },
        // The input and the output well, each on the design system's collapsible — its trigger is the mono label here.
        input: { base: { fontFamily: mono, fontSize: 'var(--text-sm)', color: textMuted }, selectors: { [foldTrigger]: foldLabel, '& pre': well } },
        output: { base: { fontFamily: mono, fontSize: 'var(--text-sm)' }, selectors: { [foldTrigger]: foldLabel, '& pre': well } },
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

/**
 * Collapsed by default: chevron + "Reasoning · 6s" in text-dim — the design
 * system's `collapsible` draws the disclosure (trigger, chevron, panel); the
 * block adds its type and indents the body under the label.
 */
const reasoning: RecipeInput = {
    component: 'ai-reasoning',
    parts: {
        root: { base: { color: 'var(--color-base-content)', fontSize: 'var(--text-md)' } },
        summary: { base: { minInlineSize: '0' } },
        body: { base: { paddingInlineStart: 'calc(0.7rem + var(--space-sm))', color: textMuted, fontSize: 'var(--text-lg)', lineHeight: '1.6' } }
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
        header: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', color: 'var(--color-warning)' },
            // The plan's Open button (#490) sits at the end, after the rule when there is one.
            selectors: { '& > [data-scope="button"]': { marginInlineStart: 'auto' }, '& > [data-part="rule"] + [data-scope="button"]': { marginInlineStart: '0' } }
        },
        title: { base: { fontWeight: 'var(--weight-semibold, 600)', fontSize: 'var(--text-lg)' } },
        rule: { base: { marginInlineStart: 'auto', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, whiteSpace: 'nowrap' } },
        plan: {
            base: {
                padding: 'var(--space-sm) var(--space-md)',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-100)',
                maxBlockSize: '24rem',
                overflow: 'auto'
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
            selectors: { '& > [data-scope="button"]': { blockSize: '2.5rem' } },
            // Phones: `Allow once` takes a full row, the other two answers share the next.
            at: {
                'below-md': {
                    base: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))' },
                    selectors: { '& > :first-child': { gridColumn: '1 / -1' } }
                }
            }
        },
        'label-full': { base: { display: 'inline' }, at: { 'below-md': { base: { display: 'none' } } } },
        'label-short': { base: { display: 'none' }, at: { 'below-md': { base: { display: 'inline' } } } },
        // The one-line record a decision collapses to.
        record: { base: { margin: '0', fontSize: 'var(--text-sm)', color: textMuted } }
    },
    // Phones: the answers are touch-height.
    composes: {
        button: { within: 'actions', parts: { root: { at: { 'below-md': { base: { blockSize: controlTouch } } } } } }
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
                gap: 'var(--space-2xs)',
                appearance: 'none',
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
        // The one-line record an answer collapses to.
        record: { base: { margin: '0', fontSize: 'var(--text-sm)', color: textMuted, overflowWrap: 'anywhere' } }
    }
};

/** Card base-200, `line-strong` border, radius 10; "To" row; borderless textarea 14; attach · key hint · Send 44. */
const composer: RecipeInput = {
    component: 'ai-composer',
    keyframes: { 'ai-spin': 'to { transform: rotate(360deg); }' },
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
            // Phones (docs/design/HANDOFF.md, "Mobile specifics"): docked to the bottom as one 48 px row — attach,
            // the input, a square Send — under the "To" row and the attachments.
            at: {
                'below-md': {
                    base: {
                        display: 'grid',
                        gridTemplateColumns: `${controlTouch} minmax(0, 1fr) ${controlTouch}`,
                        gridTemplateAreas: '"to to to" "attachments attachments attachments" "attach input send" "cancel cancel cancel"',
                        alignItems: 'end',
                        gap: 'var(--space-sm)',
                        borderRadius: '0',
                        borderInline: '0',
                        borderBlockEnd: '0',
                        borderBlockStart: `var(--border) solid ${line}`,
                        padding: 'var(--space-sm) var(--space-md) calc(var(--space-md) + env(safe-area-inset-bottom, 0px))'
                    }
                }
            },
            // A drag carrying files hovers the card: the drop zone lights up.
            states: { highlighted: { borderColor: 'var(--color-primary)', borderStyle: 'dashed', background: 'var(--color-base-300)' } }
        },
        addressing: {
            base: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-sm)', fontSize: 'var(--text-sm)', color: textMuted },
            at: { 'below-md': { base: { gridArea: 'to' } } }
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
        attachments: { base: { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)' }, at: { 'below-md': { base: { gridArea: 'attachments' } } } },
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
            },
            // Still under reduced motion: the ring stays, it does not turn.
            at: { 'reduced-motion': { base: { animation: 'none' } } }
        },
        input: {
            base: { position: 'relative' },
            at: { 'below-md': { base: { gridArea: 'input' } } },
            selectors: {
                // The field fills the card; its label is for assistive tech only (`Textarea.Label visuallyHidden` — the card is the frame).
                // The mention Combobox wraps the field: both fill the card, never wider than it.
                '& [data-scope="combobox"][data-part="root"]': { display: 'flex', inlineSize: '100%', minInlineSize: '0' },
                '& [data-scope="textarea"][data-part="root"]': { display: 'flex', inlineSize: '100%', minInlineSize: '0' },
                // Borderless, 14 px — the card is the frame; the height is zero's autosize (`minRows` / `maxRows`).
                '& textarea': { display: 'block', inlineSize: '100%', minInlineSize: '0', boxSizing: 'border-box', border: 'none', background: 'transparent', boxShadow: 'none', padding: '0', fontSize: 'var(--text-lg)', lineHeight: '1.5', resize: 'none', outline: 'none' },
                // One line: an autosizing box measures its placeholder too, and a wrapped hint would grow an empty box.
                '& textarea::placeholder': { color: textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
            }
        },
        actions: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' },
            selectors: {
                '& > [data-scope="button"][data-intent="primary"]': { blockSize: controlTouch, paddingInline: 'var(--space-lg)' },
                '& > [data-scope="button"][data-intent="icon"]': { blockSize: controlTouch, inlineSize: controlTouch }
            },
            // Phones: the buttons join the card's grid.
            at: { 'below-md': { base: { display: 'contents' } } }
        },
        // `Enter to send · Shift+Enter newline`, the keys as zero Kbd caps.
        keys: { base: { marginInlineStart: 'auto', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim, whiteSpace: 'nowrap' }, at: { 'below-md': { base: { display: 'none' } } } }
    },
    composes: {
        // Phones: the input wears field chrome of its own — one 22 px row, which with the padding and border is the 48 px touch row.
        textarea: {
            within: 'input',
            parts: {
                textarea: {
                    at: {
                        'below-md': {
                            base: {
                                boxSizing: 'border-box',
                                minBlockSize: controlTouch,
                                padding: 'var(--space-md)',
                                border: `var(--border) solid ${lineStrong}`,
                                borderRadius: 'var(--radius-field)',
                                background: 'var(--color-base-100)',
                                fontSize: '15px',
                                lineHeight: '22px'
                            }
                        }
                    }
                }
            }
        },
        // Phones: attach on the start, a square Send on the end with its label read, not seen; Cancel takes its own row.
        button: {
            within: 'actions',
            parts: {
                root: {
                    at: {
                        'below-md': {
                            selectors: {
                                '&[data-intent="icon"]': { gridArea: 'attach', inlineSize: controlTouch, blockSize: controlTouch },
                                '&[data-intent="default"]': { gridArea: 'cancel' },
                                '&[data-intent="primary"]': { gridArea: 'send', inlineSize: controlTouch, blockSize: controlTouch, padding: '0', justifyContent: 'center' },
                                '&[data-intent="primary"] > span': { position: 'absolute', inlineSize: '1px', blockSize: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }
                            }
                        }
                    }
                }
            }
        }
    }
};

/**
 * Raw CSS the design system appends verbatim. Nothing is left: the running
 * dot is Badge.Dot's own `running` pulse, the attachment spinner's turn is
 * the composer recipe's `keyframes`, and the phone regime (the docked
 * composer, the approval's action grid, the message meta without its
 * environment line) is the recipes' `below-md` keys and `composes`. Kept as
 * an export so an adopting design system's `css` list does not change.
 */
export const fragmentCss = '';

/**
 * The forms' layout scope (`AgentForm`, `SchemaForm`): the pages lay the
 * sections out; the pack only spaces the button row, which otherwise sits
 * flush.
 */
const form: RecipeInput = {
    component: 'ai-form',
    parts: {
        root: { base: { minInlineSize: '0' } },
        actions: { base: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-sm)' } }
    }
};

/**
 * The app shell's own marks (`AppShell`): the mono wordmark beside its 28 px
 * `a/` tile, and the spacer that pushes the sidebar's foot down. The layout
 * regimes (docked sidebar, phone app bar) are `shell.css`, over zero's
 * Drawer, Navbar and NavList.
 */
const shell: RecipeInput = {
    component: 'ai-shell',
    parts: {
        brand: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-sm)',
                fontFamily: mono,
                fontSize: '15px',
                fontWeight: 'var(--weight-semibold, 600)',
                letterSpacing: 'var(--tracking-tight, -0.01em)',
                color: 'var(--color-base-content)'
            }
        },
        'brand-mark': {
            base: {
                display: 'inline-grid',
                placeItems: 'center',
                inlineSize: '28px',
                blockSize: '28px',
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-primary)',
                color: 'var(--color-primary-content)',
                fontWeight: 'var(--weight-bold, 700)',
                fontSize: 'var(--text-lg)'
            }
        },
        'sidebar-spacer': { base: { flex: '1 1 auto' } }
    }
};

export const recipes: readonly RecipeInput[] = [thread, message, toolCall, reasoning, approval, question, composer, form, shell];
