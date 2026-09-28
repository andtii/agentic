# Chat modes — design reference

The design reference for the chat modes ([#1050](https://github.com/andtii/agentic/issues/1050)), in the repo so any agent can read it from a cold start. It comes from the UI handoff package (`agentic-ui-handoff`); the live canvas is https://claude.ai/artifact/3eEJpPfwQdxsH5GtGJtw87 (page **Chat modes**).

- [`HANDOFF.md`](HANDOFF.md) is the whole-app handoff, copied unchanged so sub-issues can cite its line numbers. The chat-modes spec is its "Chat modes" section (lines 532–646): the turn, detail levels, views (Focus, Team, Lanes), parts and rules, what the runtimes must send, build order. Its image links for boards outside Chat modes point at screenshots not copied here.
- `artboards/` has the source of the four Chat modes boards (`*.dc.html`, static HTML with inline styles) and `canvas.json` (sizes and pages). Exact measurements can be read from these files. They load the canvas runtime (`./support.js`, not vendored), so open them in the design canvas or strip that script tag to view them in a browser.
- `screenshots/` has one PNG per board at 1x.
- [`tokens.json`](tokens.json) holds the design tokens in machine-readable form.

The requirements are CHT-09 (runtime controls: inspect progress) and COL-09 (traceability of delegation) in [`docs/requirements.md`](../../requirements.md). The decisions that settle the handoff's gaps — including its correction that handoff lines come from `delegate`, `plan_assign` and `plan_handoff`, not `tasks_delegate` — are in [`docs/decisions.md`](../../decisions.md) (2026-09-28, chat modes). Each sub-issue has a placeholder in [`docs/architecture.md`](../../architecture.md) §10 "Chat modes (#1050)". All names, tasks and counts on the boards are invented sample data.

| Board | What it shows |
| --- | --- |
| [ChatFocus](screenshots/ChatFocus.png) | Focus view: one agent working, full prose, collapsed and expanded steps boxes, a failed step's excerpt, the live line |
| [ChatTeam](screenshots/ChatTeam.png) | Team view: crew strip, handoff lines, work cards, folded talk, a question for you, the Follow panel |
| [ChatLanes](screenshots/ChatLanes.png) | Lanes view (pinned only): the coordinator's latest message, then a column per working agent |
| [TranscriptParts](screenshots/TranscriptParts.png) | step line states, turn summary states, the views table, what reaches the thread, how an output excerpt is picked |
