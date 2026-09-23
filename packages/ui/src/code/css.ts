/**
 * Raw rules for the code surface that recipes cannot express (#563): the
 * class names the Monaco renderer hands Monaco for its decorations (Monaco
 * owns that DOM, so the design system cannot stamp scopes on it), and the
 * box the editor fills. Colours still come only from tokens.
 */
export const codeCss = `/* the Monaco renderer: the editor fills the surface; the plain grid stays underneath until Monaco is ready */
[data-scope="ag-code"][data-engine="monaco"] { position: relative; padding: 0; overflow: hidden; min-block-size: 240px; }
[data-scope="ag-code"][data-engine="monaco"] > [data-monaco-host] { position: absolute; inset: 0; }
[data-scope="ag-code"][data-engine="monaco"]:not([data-ready]) > [data-monaco-host] { visibility: hidden; }
[data-scope="ag-code"][data-engine="monaco"][data-ready] > [data-plain] { display: none; }
[data-scope="ag-code"][data-engine="monaco"] > [data-plain] { block-size: 100%; display: flex; flex-direction: column; }

/* line marks: the 3 px stripe in the decorations lane, and the line a question is about */
.ag-code-stripe { margin-inline-start: 3px; inline-size: 3px !important; }
.ag-code-stripe-working { background: var(--color-info); }
.ag-code-stripe-live { background: var(--color-primary); }
.ag-code-stripe-failed { background: var(--color-error); }
.ag-code-stripe-needs-you { background: var(--color-warning); }
.ag-code-selected { box-shadow: inset 2px 0 0 var(--color-warning); }
[data-scope="ag-code"][data-engine="monaco"][data-clickable] .monaco-editor .line-numbers { cursor: pointer; }

/* below 768 px (docs/design/HANDOFF.md → "Responsive behaviour"): the session bar wraps — tabs, then who and
   where, then the view's controls — and the widget under a line takes the width */
@media (max-width: 767px) {
    [data-scope="ag-session-bar"][data-part="root"] { flex-wrap: wrap; gap: 0 16px; padding: 0 16px; }
    [data-scope="ag-session-bar"][data-part="tabs"] { gap: 16px; }
    [data-scope="ag-session-bar"][data-part="divider"] { display: none; }
    [data-scope="ag-session-bar"][data-part="context"] { flex-basis: 100%; padding-block-end: 8px; }
    [data-scope="ag-session-bar"][data-part="controls"] { flex-basis: 100%; flex-wrap: wrap; margin-inline-start: 0; padding-block-end: 8px; }
    [data-scope="ag-code"][data-part="widget"] { margin-inline: 8px; }
}
`;
