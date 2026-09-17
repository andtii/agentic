/**
 * The raw rules the kit needs beside its recipes, appended verbatim to the
 * compiled design system through `DesignSystemInput.css`:
 *
 * - an accessible-only text helper (`data-visually-hidden`) for table
 *   captions, hidden column heads and skeleton "Loading" text;
 * - the responsive behaviour recipes cannot express (`docs/design/HANDOFF.md`
 *   → "Responsive behaviour", "Mobile specifics"): below 1280 px fixed table
 *   columns give up their drawn widths; below 768 px tables stack into
 *   cards, buttons grow to the 48 px touch height and split a row evenly,
 *   and an environment card folds into a 52 px row.
 */
export const kitCss = `[data-visually-hidden] {
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
[data-align="end"] { display: block; text-align: end; }

/* the table's box: visually hidden head text is absolutely positioned and must stay inside it */
[data-ag-table] { position: relative; min-inline-size: 0; }

/* a label never wraps: the button grows, the row wraps */
[data-scope="button"][data-part="root"] { white-space: nowrap; }
[data-scope="button"][data-part="root"] > span { white-space: nowrap; }

/* ---- 768–1279: drawn column widths yield, and a table wider than its column scrolls inside it, never the page ---- */
@media (max-width: 1279.98px) {
    [data-ag-table] { overflow-x: auto; }
    [data-ag-table] col { width: auto !important; }
}

/* ---- < 768: touch sizes, stacked tables, folded environment cards ---- */
@media (max-width: 767.98px) {
    [data-scope="button"][data-part="root"] { min-block-size: var(--ag-control-h-touch); }
    [data-scope="button"][data-part="root"][data-intent="icon"] { min-inline-size: var(--ag-control-h-touch); }

    /* action rows: full width or split evenly; an approval card inside takes its own full row */
    [data-scope="ag-needs-item"][data-part="actions"] > *,
    [data-scope="ag-failure"][data-part="actions"] > *,
    [data-scope="ag-empty"][data-part="actions"] > * { flex: 1 1 0; }
    [data-scope="ag-needs-item"][data-part="actions"] > [data-scope="ai-approval"] { flex: 1 1 100%; }
    [data-scope="ag-needs-item"][data-part="actions"] { grid-column: 1 / -1; }

    /* the environment line never wraps: where it cannot fit, the machine segment goes last */
    [data-scope="ag-env-line"][data-fit="drop-machine"] > [data-scope="ag-env-line"][data-part="machine"],
    [data-scope="ag-env-line"][data-fit="drop-machine"] > [data-scope="ag-env-line"][data-part="machine"] + [data-part="sep"] { display: none; }

    /* the table becomes one card per row; the head row is read, not seen */
    [data-ag-table] [data-scope="table"][data-part="root"],
    [data-ag-table] [data-scope="table"][data-part="body"],
    [data-ag-table] [data-scope="table"][data-part="row"] { display: block; inline-size: 100%; }
    [data-ag-table] colgroup { display: none; }
    [data-ag-table] [data-scope="table"][data-part="head"] {
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
    [data-ag-table] [data-scope="table"][data-part="body"] {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
    }
    [data-ag-table] [data-scope="table"][data-part="body"] > [data-scope="table"][data-part="row"] {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
        padding: var(--space-lg);
        border: var(--border) solid var(--ag-line);
        border-radius: var(--ag-radius-xl, var(--radius-box));
        background: var(--color-base-200);
    }
    [data-ag-table] [data-scope="table"][data-part="body"] > [data-scope="table"][data-part="row"]:hover { background: var(--color-base-200); }
    [data-ag-table] [data-scope="table"][data-part="cell"] {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        gap: var(--space-md);
        align-items: start;
        padding: 0;
        border: 0;
        min-inline-size: 0;
    }
    [data-ag-table] [data-scope="table"][data-part="cell"]::before {
        content: var(--ag-col-label, "");
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        font-weight: var(--weight-medium);
        letter-spacing: var(--tracking-wider);
        text-transform: uppercase;
        color: var(--ag-text-dim);
        padding-block-start: 3px;
    }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(1) { --ag-col-label: var(--ag-col-1); }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(2) { --ag-col-label: var(--ag-col-2); }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(3) { --ag-col-label: var(--ag-col-3); }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(4) { --ag-col-label: var(--ag-col-4); }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(5) { --ag-col-label: var(--ag-col-5); }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(6) { --ag-col-label: var(--ag-col-6); }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(7) { --ag-col-label: var(--ag-col-7); }
    [data-ag-table] [data-scope="table"][data-part="cell"]:nth-child(8) { --ag-col-label: var(--ag-col-8); }
    [data-ag-table] [data-scope="table"][data-part="cell"] [data-align="end"] { text-align: start; }
    [data-ag-table] [data-scope="table"][data-part="cell"] [data-scope="ag-env-line"] { white-space: normal; }

    /* an environment is a 52 px row: name + auth pill, runtime and capacity, default-agent tiles */
    [data-scope="ag-env-card"][data-part="root"] {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas: "header header" "line default" "capacity default" "fix fix" "actions actions";
        align-items: center;
        column-gap: var(--space-md);
        row-gap: var(--space-2xs);
        min-block-size: 52px;
        padding: var(--space-md) var(--space-lg);
    }
    [data-scope="ag-env-card"][data-part="header"] { grid-area: header; flex-wrap: nowrap; }
    [data-scope="ag-env-card"][data-part="header"] > [data-scope="ag-env-card"][data-part="status"] { display: none; }
    [data-scope="ag-env-card"][data-part="line"] { grid-area: line; }
    [data-scope="ag-env-card"][data-part="capacity"] { grid-area: capacity; }
    [data-scope="ag-env-card"][data-part="facts"] { grid-area: default; display: block; }
    [data-scope="ag-env-card"][data-part="facts"] > *:not([data-scope="ag-env-card"][data-part="default-for"]) { display: none; }
    [data-scope="ag-env-card"][data-part="fix"] { grid-area: fix; }
    [data-scope="ag-env-card"][data-part="actions"] { grid-area: actions; }
}
`;
