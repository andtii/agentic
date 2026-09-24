/**
 * The `agentic` design system's tokens: zero-daisyui's declaration with one
 * theme, `control-room`, and the handoff's `--ag-*` custom properties
 * (`docs/design/HANDOFF.md` → "Design tokens", `docs/design/tokens.json`).
 *
 * Colour only ever means state. `primary` and `success` are both `live`
 * (healthy, primary action); `info` is `working`; `warning` is `needs-you`;
 * `error` is `failed`. The roles the handoff does not name — `neutral`,
 * `secondary`, `accent` — take the nearest handoff value so daisy's recipes
 * keep a complete palette: neutral is the raised surface (default button
 * fill), secondary is the muted text, accent is the working cyan.
 *
 * Dark only in v1 (`docs/decisions.md`): `control-room` is the one default
 * (`defaultLight`, no `defaultDark`). The kit (0.3+) states the default
 * theme's own scheme on `:root` (`color-scheme: dark`), so native controls
 * and scrollbars follow it with no app-level pin.
 *
 * Pure data: the kit import is type-only, so `dist/design-system.js` loads
 * in a Node build script without the kit's Node-only barrel.
 */
import type { ContrastPairDecl, CustomTokenDecl, ScopeVocabulary, SystemTokens, ThemeInput, TokensInput } from '@sigx/zero-kit';
import { tokens as daisy } from '@sigx/zero-daisyui';
import { kitScopes } from '../kit/vocabulary.js';
import { codeScopes } from '../code/vocabulary.js';
import { scopes as packScopes } from '../fragment/scopes.js';

type Daisy = typeof daisy;
/** daisyUI's eight roles — the vocabulary every daisy recipe keys `color` on. */
export type Roles = NonNullable<Daisy['roles']>;
const daisySystem = daisy.system as NonNullable<Daisy['system']>;
const daisyCustom = (daisy.custom ?? {}) as Record<string, CustomTokenDecl>;
const daisyDark = daisy.themes['dark'] as ThemeInput;

/** The one theme. */
export const THEME = 'control-room';

/** `docs/design/tokens.json` → `color`. */
export const palette = {
    'base-100': '#0D100F',
    'base-200': '#131716',
    'base-300': '#1A1F1E',
    line: '#252B29',
    'line-strong': '#343C39',
    text: '#E7ECE9',
    'text-muted': '#A3ADA8',
    'text-dim': '#7F8A85',
    live: '#C9F26C',
    'live-ink': '#10140A',
    working: '#62D4E3',
    'working-ink': '#06191C',
    'needs-you': '#F0B429',
    'needs-you-ink': '#1A1204',
    failed: '#F47C7C',
    'failed-ink': '#2A0A0A',
    'link-hover': '#DDF89B'
} as const;

/** `docs/design/tokens.json` → `agentHue`: the four identity hues, by slot. */
export const AGENT_HUES = ['#B9A5F5', '#F5A36B', '#F08FB4', '#7FB2F5'] as const;

/**
 * The non-colour token values. Spread over daisy's so every category daisy
 * declares stays declared; the handoff's scale replaces the values.
 */
export const system = {
    ...daisySystem,
    radius: { selector: '4px', field: '6px', box: '8px' },
    typography: {
        ...daisySystem.typography,
        fonts: {
            sans: "'Schibsted Grotesk', 'Segoe UI', system-ui, sans-serif",
            mono: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"
        },
        // text-label/pill 11 · caption/data 12 · body 13 · message 14 · section 18 · title 24 · display 28
        sizes: { xs: '11px', sm: '12px', md: '13px', lg: '14px', xl: '18px', '2xl': '24px', '3xl': '28px' },
        leading: { none: 1, tight: 1.25, normal: 1.45, relaxed: 1.6 },
        // wide = pills (0.04em), wider = labels (0.08em)
        tracking: { tight: '-0.01em', normal: '0em', wide: '0.04em', wider: '0.08em' }
    },
    spacing: { '2xs': '2px', xs: '6px', sm: '8px', md: '12px', lg: '16px', xl: '20px', '2xl': '24px' },
    shadow: { ...daisySystem.shadow, xl: '0 24px 60px rgb(0 0 0 / 0.667)' },
    motion: {
        durations: { instant: '100ms', fast: '160ms', normal: '200ms', slow: '300ms' },
        easings: { linear: 'linear', standard: 'cubic-bezier(0.2, 0, 0, 1)', emphasized: 'cubic-bezier(0.2, 0, 0, 1)' }
    },
    border: '1px',
    disabledOpacity: '0.4'
} as const satisfies SystemTokens;

/** The `--ag-*` declarations: what daisyUI has no slot for. */
export const custom = {
    ...daisyCustom,
    'ag-line': { description: 'Card borders, row dividers.', syntax: '<color>' },
    'ag-line-strong': { description: 'Input and button borders, chips.', syntax: '<color>' },
    'ag-text-muted': { description: 'Secondary text, inactive nav.', syntax: '<color>' },
    'ag-text-dim': { description: 'Captions, timestamps, labels. 4.6:1 on base-300 — do not go darker.', syntax: '<color>' },
    'ag-link-hover': { description: 'Link hover.', syntax: '<color>' },
    'ag-agent-1': { description: 'Agent identity hue, slot 1. Monogram tile and @mention only, never status.', syntax: '<color>' },
    'ag-agent-2': { description: 'Agent identity hue, slot 2.', syntax: '<color>' },
    'ag-agent-3': { description: 'Agent identity hue, slot 3.', syntax: '<color>' },
    'ag-agent-4': { description: 'Agent identity hue, slot 4.', syntax: '<color>' },
    'ag-radius-xl': { description: 'Composer, dialogs, machine groups, mobile cards.', syntax: '<length>' },
    'ag-control-h': { description: 'Desktop buttons and icon buttons.', syntax: '<length>' },
    'ag-input-h': { description: 'Desktop inputs and selects.', syntax: '<length>' },
    'ag-control-h-touch': { description: 'Mobile buttons and the composer.', syntax: '<length>' },
    'ag-touch-min': { description: 'Minimum icon-only touch target.', syntax: '<length>' },
    'ag-pill-h': { description: 'Pills and tags.', syntax: '<length>' },
    'ag-sidebar-w': { description: 'The shell sidebar.', syntax: '<length>' },
    'ag-topbar-h': { description: 'The shell topbar / mobile app bar.', syntax: '<length>' },
    'ag-space-8': { description: 'Desktop page padding, main column gap (one step past the ramp).', syntax: '<length>' }
} as const satisfies Record<string, CustomTokenDecl>;

/** The one theme's `custom` values — daisy's relief knobs off (`depth`, `noise`), ours on. */
const customValues: Record<keyof typeof custom, string> = {
    ...(daisyDark.custom as Record<string, string>),
    depth: '0',
    noise: '0',
    'ag-line': palette.line,
    'ag-line-strong': palette['line-strong'],
    'ag-text-muted': palette['text-muted'],
    'ag-text-dim': palette['text-dim'],
    'ag-link-hover': palette['link-hover'],
    'ag-agent-1': AGENT_HUES[0],
    'ag-agent-2': AGENT_HUES[1],
    'ag-agent-3': AGENT_HUES[2],
    'ag-agent-4': AGENT_HUES[3],
    'ag-radius-xl': '10px',
    'ag-control-h': '36px',
    'ag-input-h': '38px',
    'ag-control-h-touch': '48px',
    'ag-touch-min': '44px',
    'ag-pill-h': '22px',
    'ag-sidebar-w': '232px',
    'ag-topbar-h': '60px',
    'ag-space-8': '28px'
} as Record<keyof typeof custom, string>;

const controlRoom: ThemeInput<Roles, typeof system> = {
    colorScheme: 'dark',
    // Tinted surfaces: pill fill 8 %, approval card 6 %, selected segment 15 % — `-soft` sits between.
    softMix: 0.12,
    colors: {
        'base-100': palette['base-100'],
        'base-200': palette['base-200'],
        'base-300': palette['base-300'],
        'base-content': palette.text,
        primary: palette.live,
        'primary-content': palette['live-ink'],
        success: palette.live,
        'success-content': palette['live-ink'],
        info: palette.working,
        'info-content': palette['working-ink'],
        accent: palette.working,
        'accent-content': palette['working-ink'],
        warning: palette['needs-you'],
        'warning-content': palette['needs-you-ink'],
        error: palette.failed,
        'error-content': palette['failed-ink'],
        neutral: palette['base-300'],
        'neutral-content': palette.text,
        secondary: palette['text-muted'],
        'secondary-content': palette['base-100']
    },
    custom: customValues
};

/** The product tones a `data-tone` axis carries — never `data-state`, whose vocabulary zero governs. */
export const TONES = ['muted', 'dim', 'live', 'working', 'needs-you', 'failed'] as const;
/** The `data-kind` axis: inbox item kinds and the six named failure states. */
export const KINDS = ['approval', 'input', 'interrupted', 'offline', 'machine', 'auth', 'runtime', 'task'] as const;
/**
 * Presence-only modifiers the kit wires (`data-mod-*`), on top of daisy's.
 * `loading` is the workdir picker's; daisy dropped it when zero made a
 * button's loading a state (zero 0.3).
 */
export const AG_MODIFIERS = ['hollow', 'outline', 'compact', 'selected', 'current', 'stale', 'loading'] as const;

/**
 * The contrast floors the handoff's inks rely on, measured by the kit's
 * `validateDesignSystem` in every theme beside its role / `-content` pairs —
 * the build and `zero:validate --strict` fail when one drops below its floor.
 */
export const contrast: ContrastPairDecl[] = [
    { fg: 'ag-text-dim', bg: 'color-base-300', min: 4.5, description: 'text-dim is the floor: 4.6:1 on base-300 per the handoff; do not go darker' },
    { fg: 'ag-text-muted', bg: 'color-base-200', min: 4.5, description: 'secondary text on the card / sidebar surface' },
    { fg: 'color-base-content', bg: 'color-base-100', min: 7, description: 'body text on the page ground (AAA)' },
    ...(['ag-agent-1', 'ag-agent-2', 'ag-agent-3', 'ag-agent-4'] as const).map((fg) => ({
        fg,
        bg: 'color-base-200',
        min: 3,
        description: 'the agent monogram on its tile, against the sidebar / card surface'
    })),
    ...(['color-primary', 'color-info', 'color-warning', 'color-error'] as const).map((fg) => ({
        fg,
        bg: 'color-base-100',
        min: 4.5,
        description: 'a state colour read as ink on the page ground'
    }))
];

/** Per scope: the fragment pack's declines, then what the kit and the code surfaces claim (a claim wins per key). */
function ownScopes(): Record<string, ScopeVocabulary> {
    const claims: Record<string, ScopeVocabulary> = { ...kitScopes, ...codeScopes };
    const out: Record<string, ScopeVocabulary> = { ...claims };
    for (const [scope, declines] of Object.entries(packScopes)) out[scope] = { ...declines, ...claims[scope] };
    return out;
}

export const tokens: TokensInput<Roles, typeof system> = {
    roles: daisy.roles,
    custom,
    variants: daisy.variants,
    modifiers: [...(daisy.modifiers ?? []), ...AG_MODIFIERS],
    axes: { ...daisy.axes, tone: [...TONES], kind: [...KINDS] },
    // daisy's sm / md / lg, plus the handoff's 1280 regime.
    breakpoints: { ...daisy.breakpoints, xl: '80rem' },
    // The pack's declines (every ai-* / ag-* scope has no colour or size axis) under the kit's own claims.
    scopes: { ...daisy.scopes, ...ownScopes() },
    system,
    contrast,
    // A single-scheme design system names its one theme as `defaultLight` (the
    // `:root` default) and omits `defaultDark`; `:root` takes its scheme.
    defaultLight: THEME,
    themes: { [THEME]: controlRoom }
};
