# Plugins redesign — design reference

The design reference for the plugins redesign ([#625](https://github.com/andtii/agentic/issues/625)), in the repo so any agent can read it from a cold start.

- [`HANDOFF-plugins.md`](HANDOFF-plugins.md) is the spec: routes, the All plugins, Connectors, Add a connector and plugin pages, the readiness pill mapping, the 2026-09-24 decisions, and the design tokens and app components those boards use.
- `screenshots/` has one PNG per board at 1x.
- `artboards/` has the source of each board (`*.dc.html`, static HTML with inline styles). Exact measurements can be read from these files. They load the canvas runtime (`support.js`, not vendored), so open them in the design canvas or strip that script tag to view them in a browser.
- [`tokens.json`](tokens.json) holds the design tokens in machine-readable form.

The decisions are in [`docs/decisions.md`](../../decisions.md) (2026-09-24). The target seams are in [`docs/architecture.md`](../../architecture.md): §9 "Target — plugins redesign" and the plugin routes in §10. The whole-app handoff is [`../HANDOFF.md`](../HANDOFF.md). All names, accounts and counts on the boards are invented sample data.

| All plugins `/plugins` | Connectors `/plugins?kind=connector` |
| --- | --- |
| ![All plugins: category menu, search, needs attention, compact rows](screenshots/Plugins.png) | ![Connectors: only the connected ones, with filter and Add connector](screenshots/PluginsConnectors.png) |

| Add a connector `/plugins/connectors/add` | Plugin page `/plugins/:id` |
| --- | --- |
| ![Add a connector: categories, search, grouped tiles, preview panel](screenshots/AddConnector.png) | ![Plugin page: account, per-tool policy, granted permissions, used by, remove](screenshots/PluginDetail.png) |
