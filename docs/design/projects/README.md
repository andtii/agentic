# Projects redesign — design reference

The design reference for the projects redesign ([#722](https://github.com/andtii/agentic/issues/722)), in the repo so any agent can read it from a cold start. The live canvas is https://claude.ai/artifact/3eEJpPfwQdxsH5GtGJtw87 (page **Projects**).

- [`HANDOFF.md`](HANDOFF.md) is the whole-app handoff, copied unchanged so sub-issues can cite its line numbers. The projects spec is its "Projects" section (lines 292–529): navigation inside a project, routes, overview, chats, features, work and pull requests, Plan, project manager and requests, links, build order. Its image links for boards outside Projects point at screenshots not copied here.
- `boards/` has the source of the 16 Projects boards (`*.dc.html`, static HTML with inline styles). Exact measurements can be read from these files. They load the canvas runtime (`./support.js`, not vendored), so open them in the design canvas or strip that script tag to view them in a browser.
- `screenshots/` has one PNG per board at 1x.
- [`tokens.json`](tokens.json) holds the design tokens in machine-readable form.

The requirements are PRJ-01 … PRJ-19 in [`docs/requirements.md`](../../requirements.md) §20. The decisions that close the handoff's open questions are in [`docs/decisions.md`](../../decisions.md) (2026-09-25). Each sub-issue has a placeholder in [`docs/architecture.md`](../../architecture.md) §10 "Projects (redesign)". All names, accounts and counts on the boards are invented sample data.

| Board | Route |
| --- | --- |
| [Projects](screenshots/Projects.png) | `/projects` |
| [Links](screenshots/Links.png) | `/projects/links` |
| [ProjectHome](screenshots/ProjectHome.png) | `/projects/:id` |
| [EventHome](screenshots/EventHome.png) | `/projects/:id`, a project with no code |
| [ProjectChats](screenshots/ProjectChats.png) | `/projects/:id/chats` |
| [ProjectCode](screenshots/ProjectCode.png) | `/projects/:id/work`, Git on |
| [ProjectPlain](screenshots/ProjectPlain.png) | `/projects/:id/work`, no code |
| [Pull](screenshots/Pull.png) | `/projects/:id/work/:item` |
| [PullSurfaces](screenshots/PullSurfaces.png) | where a pull request surfaces: chat, Home, task node, notifications |
| [ProjectFeatures](screenshots/ProjectFeatures.png) | `/projects/:id/settings/features` |
| [PMSettings](screenshots/PMSettings.png) | `/projects/:id/settings/manager` |
| [Plan](screenshots/Plan.png) | `/projects/:id/plan` (`?view=list`) |
| [PlanBoard](screenshots/PlanBoard.png) | `/projects/:id/plan?view=board` |
| [PlanAgents](screenshots/PlanAgents.png) | how agents use the plan: tools, refs, rules |
| [Requests](screenshots/Requests.png) | `/projects/:id/requests` |
| [PMChat](screenshots/PMChat.png) | a chat bringing in another project's manager |
