/**
 * What more than one patch shares: the motion shorthand, the focus ring,
 * the mono label voice and the text-field chrome.
 */
export const motion = 'var(--duration-fast) var(--ease-standard)';
/** 2 px primary ring, 2 px offset — the focus treatment of every control. */
export const ring = { outline: '2px solid var(--color-primary)', outlineOffset: '2px' };
export const mono = 'var(--font-mono)';
/** Column heads, card labels: mono 11 / 500, uppercase, tracking 0.08em. */
export const label = {
    fontFamily: mono,
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--weight-medium)',
    letterSpacing: 'var(--tracking-wider)',
    textTransform: 'uppercase',
    color: 'var(--ag-text-dim)'
};

/**
 * The field chrome the handoff gives every text control: 38 px, base-100
 * fill, `line-strong` border; hover border `text-dim`; focus border `live`
 * with no glow; disabled 60 % and `not-allowed`.
 */
export const fieldBase = {
    height: 'var(--ag-input-h)',
    background: 'var(--color-base-100)',
    borderColor: 'var(--ag-line-strong)',
    boxShadow: 'none',
    fontSize: 'var(--text-md)'
};
export const fieldStates = {
    hover: { borderColor: 'var(--ag-text-dim)' },
    'focus-visible': { outline: 'none', borderColor: 'var(--color-primary)' },
    disabled: { opacity: '0.6', cursor: 'not-allowed' }
};
