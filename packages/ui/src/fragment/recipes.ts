/**
 * The recipe pack — default styling for the six `ai-*` scopes, written
 * against the RECOMMENDED token grammar (`var(--color-primary)`,
 * `var(--space-sm)`, `var(--radius-box)`) and nothing design-system
 * specific, so any skin keeping the recommended vocabulary adopts it as is
 * and one with its own vocabulary gets it fitted (`fitRecipesToVocabulary`)
 * or writes its own. Every declared state is styled distinctly: the kit's
 * state-legibility guard measures ink, and a tool card that looks the same
 * running and denied says nothing.
 *
 * Pure data: the kit import is type-only, the anatomy imports pull no
 * component code, so a design system's Node build script imports this entry
 * without loading the sigx runtime.
 */
import type { RecipeInput } from '@sigx/zero-kit';
import { RECOMMENDED_ROLE_LIST } from '@sigx/zero/contract';

const motion = 'var(--duration-fast) var(--ease-standard)';
const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

/** The lifecycle tint a tool card / sub-agent card paints per governed state. */
const lifecycle = {
    loading: { borderColor: 'var(--color-info)', '--ai-ink': 'var(--color-info)' },
    active: { borderColor: 'var(--color-primary)', '--ai-ink': 'var(--color-primary)' },
    complete: { borderColor: 'var(--color-success)', '--ai-ink': 'var(--color-success)' },
    error: { borderColor: 'var(--color-error)', '--ai-ink': 'var(--color-error)' },
    closed: { borderColor: 'var(--color-warning)', '--ai-ink': 'var(--color-warning)', opacity: '0.85' }
};

const thread: RecipeInput = {
    component: 'ai-thread',
    parts: {
        root: {
            base: {
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-sm)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-sm)',
                background: 'var(--color-base-100)',
                color: 'var(--color-base-content)'
            },
            states: {
                on: { scrollBehavior: 'smooth' },
                off: { scrollBehavior: 'auto' }
            }
        },
        earlier: {
            base: {
                alignSelf: 'center',
                appearance: 'none',
                border: 'var(--border) solid var(--color-base-300)',
                borderRadius: 'var(--radius-selector)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                fontSize: 'var(--text-sm)',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-2xs)',
                cursor: 'pointer'
            }
        },
        list: {
            base: { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }
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
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-2xs)',
                boxShadow: 'var(--shadow-md)',
                cursor: 'pointer',
                transition: `opacity ${motion}`
            },
            // `on` is hidden by the runtime (`hiddenIn`), so the two states are
            // legitimately CSS-identical; `off` is the one that paints.
            states: { on: {}, off: { opacity: '1' } }
        }
    }
};

const message: RecipeInput = {
    component: 'ai-message',
    parts: {
        root: {
            base: { display: 'block' },
            selectors: {
                '&[data-placement="end"]': { marginInlineStart: 'var(--space-xl)' },
                '&[data-placement="start"]': { marginInlineEnd: 'var(--space-xl)' }
            }
        },
        avatar: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                inlineSize: '2rem',
                blockSize: '2rem',
                borderRadius: 'var(--radius-selector)',
                background: 'var(--color-base-300)',
                color: 'var(--color-base-content)',
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-semibold, 600)'
            }
        },
        meta: { base: { display: 'inline-flex', gap: 'var(--space-2xs)', alignItems: 'center', fontSize: 'var(--text-xs)' } },
        body: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', fontSize: 'var(--text-md)', lineHeight: 'var(--leading-normal, 1.5)' } },
        tools: { base: { display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginBlock: 'var(--space-xs)' } },
        footer: { base: { fontSize: 'var(--text-xs)', opacity: '0.7' } }
    }
};

const toolCall: RecipeInput = {
    component: 'ai-tool-call',
    tokens: { '--ai-ink': 'var(--color-base-content)' },
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2xs)',
                border: 'var(--border) solid var(--color-base-300)',
                borderInlineStartWidth: '3px',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-200)',
                color: 'var(--color-base-content)',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-xs)',
                fontSize: 'var(--text-sm)',
                transition: `border-color ${motion}`
            },
            states: lifecycle
        },
        header: { base: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-sm)', fontFamily: mono, overflowWrap: 'anywhere' } },
        status: { base: { marginInlineStart: 'auto', color: 'var(--ai-ink)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide, 0.04em)', whiteSpace: 'nowrap' } },
        input: {
            base: { fontFamily: mono, fontSize: 'var(--text-xs)' },
            states: { open: { paddingBlockEnd: 'var(--space-2xs)' }, closed: { opacity: '0.8' } },
            selectors: { '& > summary': { cursor: 'pointer' }, '& > pre': { margin: '0', overflowX: 'auto', whiteSpace: 'pre-wrap' } }
        },
        output: {
            base: { fontFamily: mono, fontSize: 'var(--text-xs)' },
            states: { open: { paddingBlockEnd: 'var(--space-2xs)' }, closed: { opacity: '0.8' } },
            selectors: { '& > summary': { cursor: 'pointer' }, '& > pre': { margin: '0', overflowX: 'auto', whiteSpace: 'pre-wrap' } }
        },
        error: { base: { margin: '0', color: 'var(--color-error)', fontSize: 'var(--text-xs)' } },
        agent: {
            base: {
                border: 'var(--border) solid var(--color-base-300)',
                borderInlineStartWidth: '3px',
                borderRadius: 'var(--radius-box)',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-xs)',
                marginBlockStart: 'var(--space-xs)'
            },
            states: lifecycle
        }
    }
};

const reasoning: RecipeInput = {
    component: 'ai-reasoning',
    parts: {
        root: {
            base: {
                border: 'var(--border) dashed var(--color-base-300)',
                borderRadius: 'var(--radius-box)',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-xs)',
                color: 'var(--color-base-content)',
                fontSize: 'var(--text-sm)'
            },
            states: { open: { background: 'var(--color-base-200)' }, closed: { opacity: '0.75' } }
        },
        summary: { base: { cursor: 'pointer', fontStyle: 'italic' } },
        body: { base: { paddingBlockStart: 'var(--space-2xs)', opacity: '0.9' } }
    }
};

const approval: RecipeInput = {
    component: 'ai-approval',
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-xs)',
                border: 'var(--border) solid var(--color-warning)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-warning-soft, var(--color-base-200))',
                color: 'var(--color-base-content)',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-xs)'
            }
        },
        title: { base: { margin: '0', fontWeight: 'var(--weight-semibold, 600)' } },
        description: { base: { margin: '0', fontSize: 'var(--text-sm)', opacity: '0.85' } },
        actions: { base: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2xs)' } }
    }
};

const composer: RecipeInput = {
    component: 'ai-composer',
    parts: {
        root: {
            base: {
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2xs)',
                border: 'var(--border) solid var(--color-base-300)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-100)',
                color: 'var(--color-base-content)',
                paddingInline: 'var(--space-sm)',
                paddingBlock: 'var(--space-xs)'
            }
        },
        attachments: { base: { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2xs)' } },
        attachment: {
            base: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2xs)',
                borderRadius: 'var(--radius-selector)',
                background: 'var(--color-base-200)',
                fontSize: 'var(--text-xs)',
                paddingInline: 'var(--space-xs)',
                paddingBlock: 'var(--space-2xs)'
            }
        },
        input: { base: { position: 'relative' } },
        mentions: {
            base: {
                position: 'absolute',
                insetBlockEnd: '100%',
                insetInlineStart: '0',
                listStyle: 'none',
                margin: '0',
                padding: 'var(--space-2xs)',
                minInlineSize: '12rem',
                border: 'var(--border) solid var(--color-base-300)',
                borderRadius: 'var(--radius-box)',
                background: 'var(--color-base-100)',
                boxShadow: 'var(--shadow-md)',
                zIndex: '1'
            },
            // `closed` is hidden by the runtime; `open` is the one that paints.
            states: { open: { display: 'block' }, closed: {} }
        },
        mention: {
            base: { paddingInline: 'var(--space-xs)', paddingBlock: 'var(--space-2xs)', borderRadius: 'var(--radius-selector)', fontSize: 'var(--text-sm)', cursor: 'pointer' },
            states: { highlighted: { background: 'var(--color-primary)', color: 'var(--color-primary-content)' } }
        },
        actions: { base: { display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', fontSize: 'var(--text-xs)' }, selectors: { '& > small': { marginInlineEnd: 'auto', opacity: '0.7' } } }
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

message.variants = colorAxis('avatar', (role) => ({ background: `var(--color-${role})`, color: `var(--color-${role}-content)` }));
thread.variants = colorAxis('anchor', (role) => ({ background: `var(--color-${role})`, color: `var(--color-${role}-content)` }));

export const recipes: readonly RecipeInput[] = [thread, message, toolCall, reasoning, approval, composer];
