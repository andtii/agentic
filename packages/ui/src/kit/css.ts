/**
 * The one raw rule the kit needs beside its recipes: an accessible-only
 * text helper (`data-visually-hidden`) for table captions, hidden column
 * heads and skeleton "Loading" text. Appended verbatim to the compiled
 * design system through `DesignSystemInput.css`.
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
`;
