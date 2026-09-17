# Agentic UI handoff package

- `HANDOFF.md` - the spec: tokens, layout, components, states, per-screen behaviour, responsive, accessibility, motion, edge cases, open questions. Screenshots are embedded from `screenshots/`.
- `screenshots/` - one PNG per artboard at 1x, plus `Mobile.png` (the four 400 px boards side by side).
- `artboards/` - the source of each artboard (`*.dc.html`, static HTML with inline styles) and `canvas.json` (sizes and pages). Exact measurements can be read from these. They reference the canvas runtime (`support.js`), so open them in the design canvas, or strip that script tag to view them in a browser.
- `tokens.json` - the design tokens from HANDOFF.md in machine-readable form.

All names, tasks, costs and token counts on the screens are invented sample data.
Live versions: canvas https://claude.ai/artifact/3eEJpPfwQdxsH5GtGJtw87 - doc https://claude.ai/code/artifact/8d5fd344-adf7-46ae-9405-278e288f2b82
