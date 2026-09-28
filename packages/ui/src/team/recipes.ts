/**
 * The team parts' recipes (#1057; `docs/design/chat-modes/HANDOFF.md` → "Team", "Lanes"), in the
 * transcript pack's token grammar (`../fragment/recipes.ts`). A member's state rides the governed
 * `data-state` on the chip, card and lane root, which sets `--ai-team-ink`: `running` is `working`
 * (info), `loading` `needs-you` (warning), `paused` and `complete` recede, `error` is `failed`. The
 * mark reads it: a turning ring (`i`) while running, a dot (`b`, hollow when idle), a check once done.
 *
 * Pure data: the kit import is type-only.
 */
import type { RecipeInput } from '@sigx/zero-kit';

const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
const line = 'var(--ag-line, var(--color-base-300))';
const lineStrong = 'var(--ag-line-strong, var(--color-base-300))';
const textMuted = 'var(--ag-text-muted, var(--color-base-content))';
const textDim = 'var(--ag-text-dim, var(--color-base-content))';
const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minInlineSize: '0' };
const tint = (c: string, pct: number): string => `color-mix(in oklab, ${c} ${pct}%, transparent)`;
const ink = 'var(--ai-team-ink)';

/** The state ink per governed state, and the hollow dot of an idle member. */
const inks = {
    running: { '--ai-team-ink': 'var(--color-info)' },
    loading: { '--ai-team-ink': 'var(--color-warning)' },
    paused: { '--ai-team-ink': textDim, '--ai-team-dot': 'transparent' },
    complete: { '--ai-team-ink': textMuted },
    error: { '--ai-team-ink': 'var(--color-error)' }
};

/** The mark: a 13 px turning ring, a 7 px dot, or the check. */
const mark = {
    base: { display: 'inline-flex', alignItems: 'center', flexShrink: '0', color: ink },
    selectors: {
        '& > i': {
            inlineSize: '13px',
            blockSize: '13px',
            boxSizing: 'border-box',
            border: `2px solid ${lineStrong}`,
            borderBlockStartColor: 'var(--color-info)',
            borderRadius: '50%',
            animation: 'ai-team-spin 800ms linear infinite'
        },
        '& > b': { inlineSize: '7px', blockSize: '7px', boxSizing: 'border-box', borderRadius: '50%', border: `1.5px solid ${ink}`, background: `var(--ai-team-dot, ${ink})` }
    },
    at: { 'reduced-motion': { selectors: { '& > i': { animation: 'none' } } } }
};
const spin = { 'ai-team-spin': 'to { transform: rotate(360deg); }' };
const name = { base: { ...ellipsis, fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold, 600)', color: 'var(--color-base-content)' } };
const time = { base: { marginInlineStart: 'auto', flexShrink: '0', fontFamily: mono, fontSize: 'var(--text-xs)', color: ink } };
const card = { border: `var(--border) solid ${line}`, borderRadius: 'var(--radius-box)', background: 'var(--color-base-200)', minInlineSize: '0' };

/** The crew strip: 4 equal columns; below 768 px one row of 13rem chips that scrolls sideways. */
const crew: RecipeInput = {
    component: 'ai-crew',
    keyframes: spin,
    parts: {
        root: {
            base: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--space-md)', minInlineSize: '0' },
            at: { 'below-md': { base: { gridTemplateColumns: 'none', gridAutoFlow: 'column', gridAutoColumns: '13rem', overflowX: 'auto' } } }
        },
        chip: {
            base: {
                ...card,
                appearance: 'none',
                font: 'inherit',
                display: 'grid',
                gridTemplateColumns: 'auto auto auto 1fr',
                alignItems: 'center',
                columnGap: 'var(--space-sm)',
                rowGap: 'var(--space-xs)',
                padding: 'var(--space-md) var(--space-lg)',
                textAlign: 'start',
                cursor: 'pointer',
                color: 'var(--color-base-content)'
            },
            states: { ...inks, selected: { borderColor: lineStrong, background: 'var(--color-base-300)' } },
            selectors: {
                '&:hover': { borderColor: lineStrong },
                '&:focus-visible': { outline: '2px solid var(--color-primary)', outlineOffset: '1px' }
            }
        },
        name,
        mark,
        elapsed: time,
        step: { base: { ...ellipsis, gridColumn: '1 / -1', fontFamily: mono, fontSize: 'var(--text-xs)', color: textMuted } },
        ask: { base: { ...ellipsis, gridColumn: '1 / -1', fontFamily: mono, fontSize: 'var(--text-xs)', color: 'var(--color-warning)' } }
    }
};

/** The 24 px handoff row: dim send icon and chevron, 13 px names, muted task, a mono ref chip. */
const handoff: RecipeInput = {
    component: 'ai-handoff',
    parts: {
        root: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minBlockSize: '24px', fontSize: 'var(--text-md)', color: textMuted, minInlineSize: '0' } },
        icon: { base: { display: 'inline-flex', color: textDim } },
        from: { base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)', flexShrink: '0', color: 'var(--color-base-content)' } },
        chevron: { base: { display: 'inline-flex', color: textDim } },
        to: { base: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-xs)', flexShrink: '0', color: 'var(--color-base-content)' } },
        task: { base: { ...ellipsis, color: textMuted } },
        ref: { base: { flexShrink: '0', paddingInline: 'var(--space-sm)', border: `var(--border) solid ${line}`, borderRadius: 'var(--radius-selector)', fontFamily: mono, fontSize: 'var(--text-xs)', color: textMuted } }
    }
};

/** The work card: base-200 on the line, the running border `working` at 33 %, the head over a divider. */
const workCard: RecipeInput = {
    component: 'ai-work-card',
    keyframes: spin,
    parts: {
        root: {
            base: { ...card, overflow: 'hidden' },
            states: {
                ...inks,
                running: { ...inks.running, borderColor: tint('var(--color-info)', 33) },
                error: { ...inks.error, borderColor: tint('var(--color-error)', 33) }
            }
        },
        head: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', paddingBlock: 'var(--space-sm)', paddingInline: 'var(--space-lg)', minInlineSize: '0' } },
        name,
        mark,
        task: { base: { ...ellipsis, flex: '1 1 auto', fontSize: 'var(--text-sm)', color: textMuted } },
        meta: { base: { flexShrink: '0', fontFamily: mono, fontSize: 'var(--text-xs)', color: ink } },
        follow: { base: { display: 'inline-flex', flexShrink: '0' } },
        result: { base: { borderBlockStart: `var(--border) solid ${line}`, padding: 'var(--space-md) var(--space-lg)', fontSize: 'var(--text-md)', lineHeight: '1.55', color: 'var(--color-base-content)' } }
    }
};

/** Folded talk: a mono 11 px label between two hairlines, `show` underlined. */
const foldedTalk: RecipeInput = {
    component: 'ai-folded-talk',
    parts: {
        root: {
            base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim },
            selectors: { '&::before, &::after': { content: '""', flex: '1 1 0', borderBlockStart: `var(--border) solid ${line}` } }
        },
        label: { base: { whiteSpace: 'nowrap' } },
        show: {
            base: { appearance: 'none', border: 'none', background: 'transparent', padding: '0', font: 'inherit', color: textMuted, textDecoration: 'underline', cursor: 'pointer' },
            selectors: { '&:hover': { color: 'var(--color-base-content)' }, '&:focus-visible': { outline: '2px solid var(--color-primary)' } }
        }
    }
};

/** A lane: a column card, the working lane on a `working` border, 12 px message boxes, a state footer. */
const lane: RecipeInput = {
    component: 'ai-lane',
    keyframes: spin,
    parts: {
        root: {
            base: { ...card, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
            states: { ...inks, running: { ...inks.running, borderColor: tint('var(--color-info)', 55) }, loading: { ...inks.loading, borderColor: tint('var(--color-warning)', 33) } }
        },
        head: {
            base: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-sm)', padding: 'var(--space-md) var(--space-lg)', borderBlockEnd: `var(--border) solid ${line}` }
        },
        name,
        mark,
        elapsed: time,
        task: { base: { ...ellipsis, flexBasis: '100%', fontSize: 'var(--text-sm)', color: textMuted } },
        body: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', flex: '1 1 auto', padding: 'var(--space-sm)', minBlockSize: '0' } },
        message: { base: { padding: 'var(--space-sm) var(--space-md)', border: `var(--border) solid ${line}`, borderRadius: 'var(--radius-field)', background: 'var(--color-base-100)', fontSize: 'var(--text-sm)', lineHeight: '1.5', color: 'var(--color-base-content)' } },
        to: { base: { fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim } },
        footer: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', padding: 'var(--space-md) var(--space-lg)', borderBlockStart: `var(--border) solid ${line}`, fontSize: 'var(--text-sm)', color: textMuted } },
        question: {
            base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', padding: 'var(--space-md) var(--space-lg)', borderBlockStart: `var(--border) solid ${tint('var(--color-warning)', 33)}`, background: tint('var(--color-warning)', 8), fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold, 600)', color: 'var(--color-warning)' }
        },
        answers: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' } }
    }
};

/** The follow panel: 330 px, mono section labels, a base-100 output well with a `live` block cursor. */
const follow: RecipeInput = {
    component: 'ai-follow',
    keyframes: { 'ai-follow-blink': '50% { opacity: 0; }' },
    parts: {
        root: { base: { ...card, display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', inlineSize: '330px', maxInlineSize: '100%', padding: 'var(--space-lg)', boxSizing: 'border-box' } },
        head: { base: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-sm)' } },
        title: { base: { margin: '0', fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold, 600)', color: 'var(--color-base-content)' } },
        task: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold, 600)', color: 'var(--color-base-content)', ...ellipsis } },
        env: { base: { ...ellipsis, marginBlockStart: 'calc(-1 * var(--space-sm))', fontFamily: mono, fontSize: 'var(--text-xs)', color: textDim } },
        label: { base: { margin: '0', fontFamily: mono, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium, 500)', letterSpacing: '0.08em', textTransform: 'uppercase', color: textDim } },
        output: {
            base: {
                margin: '0',
                padding: 'var(--space-md)',
                border: `var(--border) solid ${line}`,
                borderRadius: 'var(--radius-field)',
                background: 'var(--color-base-100)',
                fontFamily: mono,
                fontSize: 'var(--text-xs)',
                lineHeight: '1.6',
                color: textMuted,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere'
            }
        },
        cursor: {
            base: { display: 'inline-block', inlineSize: '0.5em', blockSize: '1.1em', verticalAlign: 'text-bottom', background: 'var(--color-info)', animation: 'ai-follow-blink 1s steps(1) infinite' },
            at: { 'reduced-motion': { base: { animation: 'none' } } }
        },
        result: { base: { fontSize: 'var(--text-md)', lineHeight: '1.55', color: 'var(--color-base-content)' } },
        actions: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' } },
        note: { base: { margin: '0', fontSize: 'var(--text-xs)', lineHeight: '1.5', color: textDim } }
    }
};

export const teamRecipes: readonly RecipeInput[] = [crew, handoff, workCard, foldedTalk, lane, follow];
