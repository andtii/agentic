/**
 * The raw rules the kit needs beside its recipes, appended verbatim to the
 * compiled design system through `DesignSystemInput.css`:
 *
 * - the folder picker's dialog (#191) and the document dialog (#490), wider
 *   than a confirm — `:has()` on zero's dialog popup, which no kit recipe
 *   owns; the widths read `--ag-dialog-w-wide` / `--ag-dialog-w-doc` with the
 *   handoff's 640 / 880 px as fallbacks;
 * - the shiki token colour in a markdown code block, which reads a variable
 *   no design system declares;
 * - `ConfirmDialog`'s list of dependents inside zero's dialog popup: the
 *   mono label over the named list.
 *
 * Everything responsive lives in the recipes (`below-md` / `below-xl` keys
 * and the `table` / `button` patches), so the breakpoint ramp is the only
 * source of a width.
 */
export const kitCss = `/* the folder picker's dialog: wider than a confirm; border-box, so width: calc(100% - 2rem) keeps the 16 px gutter with its padding */
[data-scope="dialog"][data-part="popup"]:has([data-scope="ag-workdir-picker"]) { max-width: var(--ag-dialog-w-wide, 640px); box-sizing: border-box; }

/* a document dialog (#490): 880 px, never taller than the viewport; the document scrolls between the title and the footer.
   Only the width goes on the popup — its display is the UA's (a closed <dialog> is display: none), so the column is the inner box */
[data-scope="dialog"][data-part="popup"]:has([data-ag-document]) { max-width: var(--ag-dialog-w-doc, 880px); box-sizing: border-box; }
[data-ag-document] { display: flex; flex-direction: column; max-block-size: calc(100dvh - 2rem - 2 * var(--space-2xl)); }
[data-ag-document-body] { flex: 1; min-block-size: 0; overflow: auto; overscroll-behavior: contain; }

/* a confirm's dependents: the mono label voice over the list of names */
[data-confirm-dependents] > p { margin: 0 0 var(--space-xs); font-family: var(--font-mono); font-size: var(--text-xs); letter-spacing: var(--tracking-wider); text-transform: uppercase; color: var(--ag-text-dim); }
[data-confirm-dependents] > ul { margin: 0 0 var(--space-lg); padding-inline-start: var(--space-lg); font-size: var(--text-md); }

/* highlighted code (#490): shiki writes each token's dark colour to --shiki-dark; control-room is dark, so that is the one shown */
[data-scope="ag-markdown"] [data-scope="richtext"][data-part="code-body"] span { color: var(--shiki-dark, inherit); }
`;
