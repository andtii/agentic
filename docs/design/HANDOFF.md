# Agentic UI — Design Handoff

2026-09-17 · Andii

## Overview

This hands off the [Agentic UI canvas](https://claude.ai/artifact/3eEJpPfwQdxsH5GtGJtw87): 20 artboards covering every route in `docs/architecture.md` §10, built as a dark "control room" daisyUI theme on `@sigx/zero-daisyui`. The artboards are static HTML with inline styles, so every measurement below can be read off the source. All 20 were rendered in Chromium at their own size; the render found two layout bugs (Home task table, Schedules columns), both fixed on the canvas and in the screenshots below.

All names, tasks, costs and token counts on the boards are invented sample data. Copy the structure, not the content.

| Artboard | Route | Size | Implements |
| --- | --- | --- | --- |
| `Main` | `/` | 1440 × 1100 | [#40](https://github.com/andtii/agentic/issues/40) inbox, [#34](https://github.com/andtii/agentic/issues/34) |
| `Chat` | `/chats/:id` | 1440 × 1240 | [#24](https://github.com/andtii/agentic/issues/24), [#34](https://github.com/andtii/agentic/issues/34), [#40](https://github.com/andtii/agentic/issues/40) |
| `Task` | `/tasks/:id` | 1440 × 1080 | #39 delegation, COL-09, COL-12 |
| `Session` | `/sessions/:id` | 1440 × 1040 | AGT-09, CHT-09, session grants from [#40](https://github.com/andtii/agentic/issues/40) |
| `Agents` | `/agents` | 1440 × 820 | [#25](https://github.com/andtii/agentic/issues/25) |
| `AgentConfig` | `/agents/:id` config | 1440 × 1560 | [#25](https://github.com/andtii/agentic/issues/25), AGT-02, AGT-06 |
| `AgentMemory` | `/agents/:id` memory | 1440 × 1100 | #41, MEM-06, MEM-08 |
| `Machines`, `Machine` | `/machines`, `/machines/:id` | 1440 × 900, 1000 | [#36](https://github.com/andtii/agentic/issues/36), #43 |
| `Pair` | `/pair` | 1440 × 820 | [#36](https://github.com/andtii/agentic/issues/36), USR-04 |
| `Schedules` | `/schedules` | 1440 × 720 | #42, AST-02..07 |
| `Plugins` | `/plugins` | 1440 × 1180 | #48, AC-13 |
| `Settings` | `/settings` | 1440 × 1020 | [#25](https://github.com/andtii/agentic/issues/25), OPS-10 |
| `History` | no route in §10 yet | 1440 × 800 | #44 |
| `Usage` | no route in §10 yet | 1440 × 900 | #45 |
| `MobileHome`, `MobileChat`, `MobileMachines`, `MobileNav` | same routes at 400 px | 400 × 860 (chat 980) | [#47](https://github.com/andtii/agentic/issues/47) |
| `Foundations` | none | 1440 × 1500 | [#23](https://github.com/andtii/agentic/issues/23) tokens, [#46](https://github.com/andtii/agentic/issues/46) states |

Start with `Foundations`: it is the single reference for tokens, status pills, tool-call states and failure states. Every other board reuses those parts unchanged.

## Screens

Rendered from the artboard source at 1×, at the artboard's own size. Sample data throughout.

### Foundations

![Foundations: tokens, type, identity, task status, tool-call states, approval card, failure states](screenshots/Foundations.png)

### Home `/`

![Home: needs-you inbox, today and spend rail, active tasks table](screenshots/Main.png)

### Chat `/chats/:id`

![Chat: chat list, thread with tool calls and approval card, composer, members and tasks panel](screenshots/Chat.png)

### Task `/tasks/:id`

![Task: delegation tree, approval, contract, transitions, result](screenshots/Task.png)

### Session `/sessions/:id`

![Session: tool call, compact approval, event log, execution, capabilities, grants](screenshots/Session.png)

### Agents `/agents`

![Agents roster](screenshots/Agents.png)

### Agent config `/agents/:id`

![Agent config form with approval policy and versions rail](screenshots/AgentConfig.png)

### Agent memory `/agents/:id`

![Agent memory list with kinds, provenance and confidence](screenshots/AgentMemory.png)

### Machines `/machines`

![Machines with environments, one expired account, an offline machine and the platform row](screenshots/Machines.png)

### Machine `/machines/:id`

![Machine detail with environments, sessions, doctor and revoke](screenshots/Machine.png)

Since #482 the page is where a machine is set up and controlled, no terminal needed after the install line. Under the header, a **setup checklist** (`[data-setup-checklist]`): Paired → Folders → Environment → Signed in → Ready; done steps fold to a tick and a word, the current one is open with its note and one action (Rename, Choose folders, Add environment, Show the command, Run the doctor), the rest dim; once everything is done it is one line. Above the environments, **Folders the web may use** (`[data-policy-card]`, `data-policy-state` = `web` / `local` / `locked` / `off` / `no-feature`): each root as asked beside what the daemon made of it (`~ → C:\Users\andy`, a `not applied yet` tag until the machine reports it), a WEB / LOCAL / LOCKED / OFF pill, who set it and when; an "Add a folder" field (a `~` form or a full path), **Browse…** (a picker over the whole machine in the workdir picker's anatomy: the machine's roots, then folders; "Allow this folder"), Remove per row, **Save folders** once the list differs and **Discard**. Saving (and browsing) asks the user to confirm with GitHub once (the elevate dialog, #355); a locked machine is read-only with the `agentic-daemon policy unlock` command well; a daemon that predates web-set folders keeps the local `allow-root` well. The environment dialog gains an **Allow bypassPermissions** switch (on needs the same confirmation). **This machine** gains **Restart…** (a confirm naming the running turns, a When-idle / Now choice; the update card then follows the restart and ends on "Restarted at …") and a **Daemon log** disclosure (the last 200 lines, monospace, Refresh, "the file holds more", and an explanation when the daemon runs in a terminal).

### Pair `/pair`

![Pairing steps with six-character code](screenshots/Pair.png)

Step 2 carries the machine name and, since #482, **Folders the web may use** (`[data-pair-folders]`, a textarea, one per line, default `~`): they ride the pending record and become the machine's policy on its first hello, so a fresh machine is usable from the page at once. Changing either field mints a fresh code. Full paths also go on the by-hand `agentic-daemon pair` command as `--allow-root` for a headless install; a `~` form never does (the daemon's `pair` takes absolute paths only).

### Schedules `/schedules`

![Schedules table](screenshots/Schedules.png)

### Plugins `/plugins`

![Plugin cards and the disable-with-dependents dialog](screenshots/Plugins.png)

### Settings `/settings`

![Settings sections](screenshots/Settings.png)

### History

![Audit history table](screenshots/History.png)

### Usage

![Usage stats, cost per day and per-agent table](screenshots/Usage.png)

### Mobile at 400 px

![Mobile: inbox with approval, chat with composer, machines, drawer](screenshots/Mobile.png)

## Design tokens

Ship these as one custom daisyUI theme named `control-room`, plus a small set of `--ag-*` custom properties for what daisyUI has no slot for. Components reference the token, never the hex.

Colour only ever means state. Lime is healthy or the primary action, cyan is an agent working, amber is waiting on a person, red is failed or destructive. Agent identity hues appear only on the square monogram tile and the @mention, never on status.

### Colour

| Token | daisyUI slot | Value | Usage |
| --- | --- | --- | --- |
| `base-100` | `--color-base-100` | `#0D100F` | Page ground, input fill, code and output wells |
| `base-200` | `--color-base-200` | `#131716` | Sidebar, cards, tables, composer |
| `base-300` | `--color-base-300` | `#1A1F1E` | Selected row or nav item, dialogs, default button fill |
| `line` | `--ag-line` | `#252B29` | Card borders, row dividers |
| `line-strong` | `--ag-line-strong` | `#343C39` | Input and button borders, chips |
| `text` | `--color-base-content` | `#E7ECE9` | Primary text |
| `text-muted` | `--ag-text-muted` | `#A3ADA8` | Secondary text, inactive nav |
| `text-dim` | `--ag-text-dim` | `#7F8A85` | Captions, timestamps, labels. Do not go darker: this is 4.6:1 on `base-300` |
| `live` | `--color-primary`, `--color-success` | `#C9F26C` | Primary button, online, auth ok, active nav marker, links |
| `live-ink` | `--color-primary-content` | `#10140A` | Text on `live` fills |
| `working` | `--color-info` | `#62D4E3` | `active` task, `running` tool call, streaming |
| `needs-you` | `--color-warning` | `#F0B429` | `waiting` task, approval card, inbox badge. Text on it is `#1A1204` |
| `failed` | `--color-error` | `#F47C7C` | `failed`, `denied`, `error`, destructive buttons |
| `link-hover` | `--ag-link-hover` | `#DDF89B` | Link hover |

Tinted surfaces are the state colour with alpha, not new tokens: pill fill 8% (`14`), pill border 33% (`55`), approval card fill 6% (`0F`) and border 40% (`66`), selected segment fill 15% (`26`).

### Agent identity hues

| Agent slot | Value | Tile fill | Tile border |
| --- | --- | --- | --- |
| 1 | `#B9A5F5` | hue at 12% | hue at 40% |
| 2 | `#F5A36B` | hue at 12% | hue at 40% |
| 3 | `#F08FB4` | hue at 12% | hue at 40% |
| 4 | `#7FB2F5` | hue at 12% | hue at 40% |

The design only defines four. Assign by creation order and store the hue on the Agent so it never changes. More than four agents needs a longer palette, which is an open question below.

### Type

| Token | Family | Size / weight | Usage |
| --- | --- | --- | --- |
| `font-sans` | Schibsted Grotesk, Segoe UI, system-ui |  | All interface text |
| `font-mono` | JetBrains Mono, Cascadia Mono, Consolas |  | Anything a machine said: ids, environments, commands, costs, timestamps, pills |
| `text-display` | sans | 28 / 600 | Page hero (Pair), large stats use mono 28 / 600 |
| `text-title` | sans | 24 / 600 | Agent and machine name in a detail header |
| `text-section` | sans | 18 / 600 | "Needs you", "Active tasks" |
| `text-crumb` | sans | 15 / 600 current, 500 parent | Topbar breadcrumb |
| `text-message` | sans | 14 / 400, line-height 1.6 | Chat message body, `text-wrap: pretty` |
| `text-body` | sans | 13 / 400, line-height 1.45 | Default interface text |
| `text-caption` | sans | 12 / 400 | Hints, secondary lines |
| `text-data` | mono | 12 / 400 | Environment line, event log, tool args |
| `text-label` | mono | 11 / 500, uppercase, tracking 0.08em | Column heads, card labels |
| `text-pill` | mono | 11 / 500, tracking 0.04em | Status pills and tags |

Both families load from Google Fonts with weights 400, 500, 600, 700.

### Spacing, radii, sizes

| Token | Value | Usage |
| --- | --- | --- |
| `space-1` | 2px | Nav item gap, stacked name and caption |
| `space-2` | 6px | Label to control, chip gaps |
| `space-3` | 8px | Inline gaps, button groups |
| `space-4` | 12px | Card stacks, grid gutters in dense grids |
| `space-5` | 16px | Card grids, table cell column gap, mobile page padding |
| `space-6` | 20px | Card padding, side panel padding |
| `space-7` | 24px | Message gap in a thread, form section padding |
| `space-8` | 28px | Desktop page padding, main column gap |
| `radius-sm` | 4px | Pills, tags, chips, segmented buttons |
| `radius-md` | 6px | Buttons, inputs, agent tiles, output wells |
| `radius-lg` | 8px | Cards, tables, tool-call and approval cards |
| `radius-xl` | 10px | Composer, dialogs, machine groups, mobile cards |
| `control-h` | 36px | Desktop buttons and icon buttons (38 for inputs, 40 inside approval cards) |
| `control-h-touch` | 48px | Mobile buttons and composer. Icon-only targets are 44 minimum |
| `pill-h` | 22px | Pills and tags |
| `shadow-dialog` | `0 24px 60px #000000AA` | Dialogs only. Nothing else has a shadow |

Icons are inline stroke SVG on a 24 grid, stroke 1.6, round caps, `currentColor`. Sizes: 14 in captions, 15 to 17 in buttons and nav, 20 on mobile and machine glyphs.

## Layout and shell

The shell is a fixed 232 px sidebar plus a fluid main column with a 60 px topbar. It lives in `packages/ui/src/shell/**` as `Navbar` + `Drawer` from zero, laid out with the hand-written `shell.css` on `data-l-*` attributes ([#23](https://github.com/andtii/agentic/issues/23)). The artboards are drawn at 1440; nothing in the main column has a max-width except Settings (860 px) and Pair (620 + 360 px).

| Region | Spec |
| --- | --- |
| Sidebar | 232 px, `base-200`, right border `line`, padding 20 / 14, vertical stack with gap 24: brand, primary nav, "Workspace" nav, spacer, connection strip, user |
| Nav item | 38 px high, radius 6, icon 17 + label 14 px. Active: `base-300` fill, text `text`, weight 600, 3 × 16 px `live` marker at the left edge. Inactive: transparent, `text-muted`, weight 500 |
| Nav badge | Home only. 20 px high, `needs-you` fill, mono 11 / 700. Count = open Inbox items of kind approval, input or interrupted |
| Connection strip | Card at the sidebar foot, one row per signal: this browser's socket, then each machine. Dot + name + mono state. It is the always-visible half of failure distinction ([#46](https://github.com/andtii/agentic/issues/46)) |
| Topbar | 60 px, bottom border `line`, padding 0 / 28. Breadcrumb left with 14 px chevrons, page actions right with gap 10 |
| Content | Padding 28. Chat is the exception: padding 0, three columns run edge to edge |

### Content grids

| Screen | Columns | Gap |
| --- | --- | --- |
| Home | `minmax(0, 1fr)` + 340 for the inbox row, then the tasks table full width | 28 |
| Chat | 280 chat list + fluid thread + 320 context panel | borders, no gap |
| Task | fluid + 460 | 28 |
| Session | fluid + 400 | 28 |
| Agent config | fluid form + 360 versions rail | 40 |
| Agent memory | fluid + 320 | 28 |
| Machine | fluid + 420 | 28 |
| Agents roster | 2 equal columns | 16 |
| Environment cards, plugin cards | 3 equal columns | 12, 16 |
| Usage stats | 4 equal columns | 16 |

Author every equal-column grid as `repeat(N, minmax(0, 1fr))`. Side rails are fixed width because their content is mono data that must not wrap; the fluid column takes the slack.

Form sections (Agent config, Settings) use a two-column row: a 200 or 240 px title-and-hint column, then the controls, with a `line` divider and 24 px vertical padding per section.

Tables are a CSS grid per row, not `<table>`, in the artboards. In code use zero's `Table`; keep the column templates: Home tasks `100px 1fr 140px 270px 60px`, History `84px 150px 130px 1fr 110px`, Schedules `110px 1fr 140px 140px 310px 44px`, Usage `1fr 120px 120px 130px 150px`. Head row padding 10 / 16, body rows 14 / 16.

## Components

Two groups: the `ai-*` fragment parts that `@agentic/ui` publishes ([#24](https://github.com/andtii/agentic/issues/24)), and app components composed from zero. Prop names are proposals; the anatomy attributes come from architecture §10.

### `ai-*` fragment

| Scope | Anatomy | Props | Visual spec |
| --- | --- | --- | --- |
| `ai-thread` | root, list, anchor | `entries`, `sessions`, `windowSize = 200` | Column, gap 24, padding 24 / 32. A centred "Showing the last 200 entries · Load earlier" chip sits at the top when history is windowed. Pauses auto-scroll when the user scrolls up |
| `ai-message` | root, avatar, meta, body, tools, footer | `author`, `time`, `environment?`, `streaming` | Row, gap 12, avatar 32 top-aligned. Meta line: name 13 / 600, environment line in `text-dim`, time mono 11, `STREAMING` pill while the session is mid-turn. Body 14 / 1.6. Tools stack under the body with gap 8 |
| `ai-tool-call` | root, header, input, output, status | `name`, `input`, `output?`, `meta?`, `data-state` | Card `base-200`, radius 8, padding 10 / 12. Header row: icon 15 in state colour, tool name mono 12 / 600, input mono 12 `text-muted` truncated with ellipsis, optional meta (duration, diff stat, task id), status pill. Output is a `base-100` well, mono 12, `pre-wrap`. Border takes the state colour for `running` and `error` only |
| `ai-reasoning` | root, summary, body | `seconds`, `open` | Collapsed by default: chevron 14 + "Reasoning · 6s" in `text-dim`. Use zero `Collapsible` |
| `ai-approval` | root (+ header, request, context, actions) | `request`, `rule`, `requestedBy`, `environment`, `via?`, `compact` | Card with `needs-you` tint and border, radius 8, padding 14, gap 12. Header: shield icon + "Approval needed" + the matching rule in mono. Request well shows tool and input verbatim. Context rows use a 96 px label column. Actions: `Allow once` (amber fill), `Allow for this session`, `Deny`, all 40 px, wrapping. `compact` drops the context rows (Session page, mobile) |
| `ai-composer` | root, input, attachments, actions | `addressing`, `hint`, `onSend`, `model` | Card `base-200`, border `line-strong`, radius 10, padding 12 / 14. Top row: "To" + address chips + right-aligned hint. Borderless auto-growing `Textarea`, 14 px. Bottom row: attach icon button, spacer, key hint, `Send` primary, 44 px |

The approval card is one component everywhere: in the chat under the message that raised it, in the Home inbox, on the Task and Session pages, and on mobile. Responding in any of them resolves all of them.

### App components

| Component | Built from (zero) | Variants | Notes |
| --- | --- | --- | --- |
| `AgentTile` | `Avatar` | 18, 20, 22, 28, 32, 44, 52 px | Square, radius 6, two-letter mono monogram in the agent hue. People use a circle. This shape difference is the only way to tell agent from user at 18 px, so keep it |
| `StatusPill` | `Badge` + `Status` | queued, active, waiting, completed, failed, cancelled, online, offline, plus free text | 22 px, 6 px dot + mono label. Hollow dot for states where nothing is happening: queued, cancelled, offline, unknown, denied |
| `Tag` | `Badge` | neutral, coloured text | Outline only. Used for kinds (memory kind, schedule kind, plugin kind) and wait reasons |
| `EnvironmentLine` | text | default, dim, strong | `machine / runtime / account` in mono 12 with `text-dim` slashes. Never render one part alone where work is attributed (EXE-06). Never wraps |
| `EnvironmentCard` | `Card` | ok, expired, unknown, offline | Name, runtime + account, capacity meter (one 18 × 6 segment per slot, `working` when used), queued count, "Default for" tiles, isolation mechanism. Expired auth turns the border `failed` and adds a fix line with `Re-check` |
| `NeedsItem` | `Card` | approval, input, interrupted | Home inbox row: tile 32, kind pill + title 14 / 600, context line, action row |
| `Button` | `Button` | primary, default, wait, danger, icon | 36 px, radius 6, 13 / 600, icon 15 with gap 8. Danger is outline only until the confirm step |
| `Segmented` | `ToggleGroup` | allow / ask / deny, by agent / task / turn | 2 px inset track, 30 px segments, `aria-pressed`. The selected policy segment takes its meaning colour at 15% |
| `Switch` | `Switch` | on, off | 40 × 24, knob 20. On = `live` track with `live-ink` knob |
| `Field`, `Select`, `ChipInput` | `Field`, `Input`, `Select`, `Combobox` | default, error, disabled | Label 12 / 600 `text-muted` above, 38 px control, `base-100` fill, `line-strong` border, hint 12 `text-dim` below. `ChipInput` is a multi-select `Combobox` whose chips are mono with a remove button |
| `DataTable` | `Table` |  | See column templates above. Whole row is not clickable; the ref or name cell is the link |
| `TaskNode` | `TreeView` item | selected, default | Depth rail: one 28 px column per level with a `line-strong` left border. Node card: tile 28, title, agent + environment, wait reason in amber mono, status pill. Selected = `base-300` fill + `live` border at 53% |
| `Timeline` | `Timeline` |  | 8 px dot in the state colour, 1 px `line-strong` connector, text 13 + mono time 11 |
| `VersionItem` | list | current, proposed, past | Proposed (from learning) carries a `NEEDS REVIEW` pill and `Review` / `Dismiss`. Past versions show "Roll back to vN" |
| `ConfirmDialog` | `Dialog` | destructive | 520 px, `base-300`, radius 10, padding 24. Must list every dependent by name before the destructive button, and the button states the consequence ("Disable and stop 2 sessions") |

## States and interactions

Every domain state in `@agentic/core` has exactly one visual. If a new state is added to core, add a row here before it reaches a screen.

### Task status

| `TaskStatus` | Pill | Colour | Dot | Rule |
| --- | --- | --- | --- | --- |
| `queued` | QUEUED | `text-muted` | hollow |  |
| `active` | ACTIVE | `working` | solid |  |
| `waiting` | WAITING | `needs-you` | solid | Always followed by its `WaitReason` in amber mono: `wait: approval · git push` |
| `completed` | COMPLETED | `text-muted` | solid | Deliberately uncoloured so finished work recedes. Result carries a separate `VERIFIED` / `NOT VERIFIED` pill (LRN-03) |
| `failed` | FAILED | `failed` | solid |  |
| `cancelled` | CANCELLED | `text-dim` | hollow | Children that did not ack the stop are listed as "could not be stopped" (COL-12) |

Wait reasons render as the literal core names: `approval`, `input`, `environment-offline`, `child`, `capacity`, `budget`. For `environment-offline` also print the policy (`policy queue`), and for `child` the child ids.

### Tool call `data-state`

| State | Pill | Border | Output well |
| --- | --- | --- | --- |
| `pending` | PENDING, hollow, `text-muted` | `line` | none |
| `running` | RUNNING, `working` | `working` | streams in |
| `done` | DONE, `text-muted` | `line` | shown if present, collapsed past 6 lines |
| `error` | ERROR, `failed` | `failed` | exit code and message |
| `denied` | DENIED, hollow, `failed` | `line` | none |

### Failure distinction ([#46](https://github.com/andtii/agentic/issues/46))

Each state has its own name, icon, signal and action. They must never collapse into a generic "Something went wrong".

| # | Name shown | Signal | Colour | Where it shows | Action |
| --- | --- | --- | --- | --- | --- |
| 1 | This browser is offline | client socket status | `text-muted` | Connection strip + a banner over the content | none, shows "Reconnecting…" |
| 2 | Machine disconnected | `Machine.online` | `needs-you` | Connection strip, machine card, session header. Session state is `disconnected`, not failed | Open machine |
| 3 | Sign-in needed on the machine | environment `authStatus` | `needs-you` | Environment card border goes `failed`, pill `AUTH EXPIRED`, fix line | Re-check |
| 4 | Runtime error | adapter `error` event | `failed` | Inline in the thread at the point of failure | Retry turn |
| 5 | Task failed | `Task.status` | `failed` | Task node, Home table, the delegating agent's message | Open task |
| 6 | Interrupted | last event is not `turn-end` | `failed` | Home inbox as `INTERRUPTED`, session header | Resume. Never auto-replay; Resume sends a new prompt over the intact transcript |

### Approvals ([#40](https://github.com/andtii/agentic/issues/40))

```mermaid
stateDiagram-v2
  [*] --> Requested: request event
  Requested --> Allowed_once: Allow once
  Requested --> Granted_session: Allow for this session
  Requested --> Denied: Deny
  Granted_session --> Revoked: Revoke on session page
  Allowed_once --> [*]
  Denied --> [*]
```

While requested, the Task is `waiting {approval}`, the Home badge counts it, and the chat list row shows an amber pill. After a decision the card collapses to one line in the thread: who decided, which scope, from which client ("Allowed for session from phone"). Session grants are listed on the Session page with `Revoke`. Buttons disable and show a spinner between click and `Session.respond` ack; a decision arriving from another tab replaces the buttons with the collapsed line without a page reload.

### Element states

| Element | Hover | Focus | Active / pressed | Disabled | Loading |
| --- | --- | --- | --- | --- | --- |
| Primary button | fill `link-hover` | 2 px `live` ring, 2 px offset | fill darkens 8% | 40% opacity, no pointer | label stays, 14 px spinner replaces the icon |
| Default button | border `text-dim` | same ring | fill `line` | 40% opacity | same |
| Danger button | fill `failed` at 8% | ring in `failed` | fill at 15% | 40% opacity | same |
| Nav item | text `text` | ring inside the item |  |  |  |
| Input, select, textarea | border `text-dim` | border `live`, no glow |  | 60% opacity, `not-allowed` |  |
| Input error |  |  |  |  | border `failed`, message 12 px `failed` under the field, `aria-describedby` |
| Table row | fill `base-300` at 50% |  |  |  | 3 skeleton rows, 14 px bars in `line` |
| Card link (agent roster, chat list) | border `line-strong` | ring |  |  |  |
| Link | `link-hover` | ring |  |  |  |

Hover, focus and disabled states are not drawn on the artboards. The values above are the spec.

## Screen specs

One row per route: what it reads, and the behaviour the artboard cannot show. Every read is `useActorState(Def, key, 'get', {live: true})` unless noted.

| Screen | Reads | Key behaviour |
| --- | --- | --- |
| Home `/` | Inbox, Task list, Schedule, Ledger summary | "Needs you" sorts approvals first, then input, then interrupted, oldest first inside each. Answering removes the row without reload. "Stop all" opens a `ConfirmDialog` listing each chain. Right rail: today's schedule in the workspace time zone, month spend against the limit |
| Chat `/chats/:id` | Chat, plus `Session.tail` per entry in `chat.activeSessions` | Streaming deltas come from sessions, never through Chat (CHT-11). Composer "To" row shows who will be activated: mentions ∩ members, else coordinator, else the single member, else "nobody will answer" in `text-dim`. Typing `@` opens a member `Combobox`. Right panel: members with status, environment line and history access; task mini-tree; "Stop task chain"; the memory privacy note (MEM-11) |
| Add agent dialog | Workspace agents | Must ask for history access: "all history" or "from now" (CHT-04). Not drawn; use `ConfirmDialog` sizing |
| Task `/tasks/:id` | `Task.tree`, Task | Left: delegation tree with depth counter "depth 1 of 3"; selecting a node swaps the right rail. Right: contract as key-value rows (120 px label column), transitions timeline, result with verified flag. An open approval for the selected node renders under the tree |
| Session `/sessions/:id` | Session, `Session.tail` | Header tile 44 + id in mono 20. Capability list is driven by `AgentCapabilities`: supported rows get a `live` check, unsupported get a `text-dim` cross and the reason. Controls for unsupported operations are not rendered at all (AC-15). Event log is mono 12 in a `44px 110px 1fr` grid with a `LIVE` pill; `request` events are amber |
| Agents `/agents` | Workspace, Agent | Two-column cards, whole card is the link. Footer stats: config version, memory count, corrections per week (LRN-09) |
| Agent config | Agent, `listVersions` | Binds `AgentConfig` through zero's `model=` contract and works without JavaScript via FormData ([#25](https://github.com/andtii/agentic/issues/25)). Save requires a reason and creates the next version. The save card appears only when the form is dirty. "Changes apply to new sessions" line states how many active sessions keep the old version (AGT-07) |
| Agent memory | `Memory.query` | Filter chips by kind with counts. Row grid `110px 1fr 100px 120px`: kind tag, text + conditions + provenance, confidence pill, actions (correct, retire, delete). Retired rows stay visible at 55% opacity with strikethrough and the superseding reason |
| Machines `/machines` | Workspace machines, Machine | One bordered group per machine, environments in three columns. The `platform` row at the bottom represents `anthropic-api` so both execution types are visible in one place. An offline machine with queued work states that it will not move to another account (EXE-12) |
| Machine `/machines/:id` | Machine | Environments, active sessions table, Doctor checklist for EXE-07, Revoke in a `failed`-bordered card. Revoke confirm must say sessions become disconnected, not failed |
| Pair `/pair` | `registerMachinePending` | Three numbered steps. Code is six 64 × 80 cells, mono 40 / 600 in `live`. Countdown from 10:00; at 0 the cells go `text-dim` and a "New code" button replaces the waiting line. On success, step 2 gets the check and the page moves to the new machine |
| Schedules `/schedules` | Schedule list | Kind tag, what, when, next run, runs on, enable switch. A schedule bound to an offline environment shows the amber policy line under its name. Footer line states the DST rule (AST-07) |
| Plugins `/plugins` | Registry | Three-column cards: name + version, kind tag, description, granted permissions, declared unsupported operations (PLG-09), dependents as tiles, enable switch. Turning a switch off with dependents opens the dialog drawn on the board |
| Settings `/settings` | Workspace settings, Registry secrets | Sections: time, notifications matrix (event × inbox, push), API keys (masked, status pill, Replace), budgets, retention, export and delete |
| History | `Audit.list(filter)` | Filter chips by kind. Grid: time, kind tag, actor, what happened, ref link. Newest first, grouped by day |
| Usage | `Ledger.summary(by)` | Segmented by agent, task, turn. Data quality column is mandatory: `REPORTED`, `PARTLY ESTIMATED`, `NOT REPORTED`. Never print 0 or a blank for unreported cost; print `n/a` in `text-dim` (OPS-07) |

## Responsive behaviour

There is one breakpoint in v1, 768 px, because zero has no layout tier yet (andtii/zero-wip#473). Below it everything is a single column. The acceptance bar is no horizontal scroll on any route at 400 px ([#47](https://github.com/andtii/agentic/issues/47)).

| Width | Changes |
| --- | --- |
| ≥ 1280 | As drawn |
| 768 to 1279 | Sidebar stays. Fixed right rails drop under the main column in this order: Home rail, Task rail, Session rail, Machine rail, Memory rail. Chat hides the 320 context panel behind the topbar's tasks button and keeps list + thread. Three-column card grids become two |
| < 768 | Sidebar becomes a `Drawer` opened from a 44 px menu button. Topbar becomes a 60 px app bar on `base-200`: menu or back, title 16 / 600 with an optional sub-line, one right slot. Page padding 16. All grids become one column. Tables become stacked cards |

### Mobile specifics

| Element | Spec |
| --- | --- |
| Drawer | 312 px wide on a `#050706` scrim, nav items 50 px high, 16 px labels, icons 20, close button 44. The connection strip stays at the foot |
| Buttons | 48 px high, full width or split evenly in a row. In the approval card `Allow once` takes a full row and the other two share the next, so the safest common answer is the biggest target |
| Composer | Docked to the bottom on `base-200` with a top border. One row: attach 48, single-line input 48 with 15 px text (avoids iOS zoom), send 48 square in `live`. The "To" row stays above it. Respect `env(safe-area-inset-bottom)` |
| Chat header | Back button, chat title, sub-line of member tiles at 16 px plus a status summary ("1 waiting · 1 active"). Right slot opens tasks for this chat |
| Messages | Environment line is dropped from the meta row; it remains inside the approval card, where it matters |
| Machines | One card per machine; each environment is a 52 px row with name, runtime and capacity, default-agent tile, auth pill |
| Long mono strings | Commands and paths use `overflow-wrap: anywhere` inside wells. The environment line never wraps; if it cannot fit, drop the machine segment last |

Do not draw or reserve a fake status bar or keyboard. The real ones sit on top.

## Accessibility, motion and edge cases

### Accessibility

- Contrast ratios here are my estimates, not tool output: `text-dim` on `base-300` is the floor at 4.6:1. `zero:validate` must pass with zero contrast failures ([#23](https://github.com/andtii/agentic/issues/23)).
- State is never colour alone. Every pill carries its word, hollow versus solid dots separate idle from live states, and tool-call and failure cards carry an icon.
- Controls are real elements: `<button>`, `<a href>`, `<input>` with `<label for>`. Visually hidden labels on the composer and search inputs. Every icon-only button has an `aria-label` ("Attach file", "Retire this memory").
- Switches use `role="switch"` with `aria-checked`; segmented controls and filter chips use `aria-pressed`. Each nav is a `<nav>` with its own `aria-label`.
- Focus order follows reading order: sidebar, topbar actions, content, right rail. In Chat: list, thread, composer, context panel. The composer keeps focus after send.
- Dialogs trap focus, close on Escape, return focus to the trigger, and default focus to the non-destructive button.
- The thread is `role="log"` with `aria-live="polite"`. Announce a message once when its turn ends, not per streamed token. A new approval request is announced assertively: "Approval needed from Forge: git push".
- Keyboard: Enter sends, Shift+Enter inserts a newline, `@` opens the mention list with arrow keys and Enter, Escape closes it.
- Touch targets are 44 px minimum on mobile; the 32 px row actions on the desktop Memory table grow to 44 below 768.

### Motion

| Element | Trigger | Animation | Duration | Easing |
| --- | --- | --- | --- | --- |
| Drawer | open, close | translateX from -100%, scrim fade | 200 ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Dialog | open | opacity and 8 px rise | 160 ms | same |
| Approval card | decision | height collapse to the one-line record | 180 ms | ease-out |
| Running pill dot | while `running` or `STREAMING` | opacity 1 to 0.4 pulse | 1200 ms loop | ease-in-out |
| New inbox row | insert | fade in, no slide | 160 ms | ease-out |
| Streaming text | token arrival | none. Text appears; no typewriter effect, no cursor |  |  |

All of it is off under `prefers-reduced-motion`, including the pulse. Nothing else animates.

### Edge cases

| Case | Behaviour |
| --- | --- |
| Empty workspace | Home shows one card: "Create your first agent", primary button to `/agents`. No empty tables |
| No machines | Machines shows the `platform` row plus a dashed card with "Pair a machine". Agents needing `claude-code` show `No environment` in amber |
| Empty inbox | "Nothing needs you." in `text-muted`, section keeps its heading |
| Empty chat | Composer only, with the activation hint as the placeholder |
| Long objective or title | One line with ellipsis in tables and tree nodes, full text in the detail rail and as `title` |
| Long tool input | Ellipsis in the header, full command in the expanded well |
| Long tool output | First 6 lines then "Show N more lines". Over 200 lines links to the session log |
| Many agents in a chat | Tiles stack to 4, then `+N` in mono |
| Deep delegation | Rail indents to depth 3, the configured maximum. Beyond that the limit blocks creation, so no deeper layout exists |
| Thread over 200 entries | Windowed; "Load earlier" pages by 200. Keep DOM rows under 200 ([#24](https://github.com/andtii/agentic/issues/24)) |
| Event gap after reconnect | Session shows "Events lost between seq A and B" in amber inside the log; state is `disconnected`, not error |
| Slow connection | Skeleton rows for tables and cards; the shell and connection strip render first from SSR |
| Cost unknown | `n/a` plus `NOT REPORTED`; estimated values are prefixed `~` and carry the `PARTLY ESTIMATED` pill |
| Pairing code expired | Cells dim, "New code" replaces the waiting line |
| Longer strings (Swedish) | Buttons size to content and action rows wrap; nav labels have 40% headroom at 232 px. Pills are fixed English enum names and are not translated in v1 |
| Time zones | Every time is the workspace zone; relative ages ("14m") switch to a date after 24 h |

## Open questions

These are the places where the design guessed or stopped. Each one blocks or bends an issue.

- [ ] **Light theme.** Only the dark theme exists. Does v1 ship dark only, or does [#23](https://github.com/andtii/agentic/issues/23) need a light pair of the same tokens?
- [ ] **History and Usage routes.** Both are in the sidebar but architecture §10 lists no route for them. Proposed: `/history` and `/usage`; §10 needs the same PR.
- [ ] **A tasks list route.** §10 has `/tasks/:id` but no `/tasks`. The design reaches tasks from Home and from a chat. The Task breadcrumb shows a "Tasks" parent that currently has nowhere to go.
- [ ] **Agent overview and sessions tabs.** The tab bar shows Overview, Config, Memory, Sessions; only Config and Memory are drawn. Sessions can reuse the Machine page's sessions table. Overview has no design.
- [ ] **Zero coverage.** The spec assumes zero has `Card`, `Collapsible` and a toggle-group. §10 does not list them. Missing ones go to andtii/zero-wip as `from:agentic` with a workaround under `packages/ui/src/_zero-gaps/`.
- [ ] **More than four agents.** The identity palette has four hues. It needs eight to twelve that stay distinct from the four state colours.
- [ ] **Render coverage.** Rendered outside the canvas runtime, with the type's script removed. Layout and fonts match; anything the canvas editor adds is not covered. Known leftover: long select values sit tight against the chevron in Settings and Agent config.
- [ ] **States not drawn.** Hover, focus, disabled, loading, empty and error-field states are specified in this doc only. The add-agent dialog, new-chat dialog, memory correct/edit form, new-schedule form and the client-offline banner are also not drawn.
- [ ] **Web Push.** Settings shows a push column. Architecture §12 says push may slip; if it does, hide the column rather than disabling it.
- [ ] **daisyUI slot mapping.** `live` is mapped to both `primary` and `success`. If zero-daisyui recipes put `success` and `primary` side by side anywhere, they will be indistinguishable; that is intended here but worth a check against the recipe pack.

## Sources

- [Agentic UI canvas](https://claude.ai/artifact/3eEJpPfwQdxsH5GtGJtw87)
- [Tracking issue #11](https://github.com/andtii/agentic/issues/11), [#23](https://github.com/andtii/agentic/issues/23), [#24](https://github.com/andtii/agentic/issues/24), [#25](https://github.com/andtii/agentic/issues/25), [#34](https://github.com/andtii/agentic/issues/34), [#36](https://github.com/andtii/agentic/issues/36), [#40](https://github.com/andtii/agentic/issues/40), [#46](https://github.com/andtii/agentic/issues/46), [#47](https://github.com/andtii/agentic/issues/47)
- `docs/architecture.md` §4, §10, §12 and `docs/requirements.md` in the repo
