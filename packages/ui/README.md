# @agentic/ui

Zero-based UI: the `agentic` design system (`control-room` theme on zero-daisyui), the ai-* chat fragment (thread, message, composer, tool call, reasoning, approval), forms, layout shell and streaming markdown.

The visual spec is `docs/design/HANDOFF.md` (tokens, layout, components, states, responsive, accessibility, motion, edge cases) with `tokens.json`, `screenshots/` and the `artboards/` source.

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.

## Design system (`src/design-system`, `@agentic/ui/design-system`)

zero-daisyui's tokens and recipes, re-tuned to the handoff and compiled by `@sigx/zero-kit` (`scripts/build-design-system.mjs`, part of `build`) into `dist/ds/**`. One theme, `control-room`, dark only. The handoff's extras are `--ag-*` custom tokens (`--ag-line`, `--ag-text-dim`, `--ag-agent-1`..., `--ag-control-h`, `--ag-sidebar-w`, ...); product states ride the `tone` and `kind` axes and the `hollow` / `outline` / `compact` / `selected` / `current` modifiers, not `data-state`.

```ts
import '@sigx/zero/css';
import '@agentic/ui/css';                 // tokens + every recipe (daisy overridden, ai-* fragment)
import '@agentic/ui/register';            // types: theme, properties, per-scope axes
import { installThemes } from '@agentic/ui/design-system';
installThemes();
```

The design system is `extendDesignSystem(daisy, …)` from `@sigx/zero-kit/define`: each re-tuned daisy scope has one `RecipePatch` in `src/design-system/patches/<scope>.ts` (objects merge per key, arrays and scalars replace, `null` deletes, a `compoundVariants` entry merges into daisy's with the same `match`) — one recipe per scope, never two. The handoff's contrast floors over the `--ag-*` inks are `tokens.contrast` pairs, measured by the kit's validator in every theme; the breakpoints are daisy's plus `xl: 80rem`. Validate with `sigx zero:validate ./node_modules/@agentic/ui/dist/design-system.js --extra-manifest ./node_modules/@agentic/ui/dist/fragment.json` (the web app's build does).

## Layout

Pages lay out with zero's layout tier — `Row`, `Col`, `Stack.Item grow`, `Grid`, `Container` from `@sigx/zero` — whose CSS this design system's build compiles from its own spacing ramp; there is no local layout tier. App CSS queries the ramp's breakpoints through `@agentic/ui/css/breakpoints` (`@custom-media --above-md` / `--below-md` and friends), which needs Lightning CSS with `drafts.customMedia`; in code, `useMediaQuery({ above: 'md' })` from `@sigx/zero/behaviors` after `installThemes()`.

```css
@import '@agentic/ui/css/breakpoints';
@media (--below-md) { … }
```

## App shell (`src/shell`)

`AppShell` is the handoff's shell: a sticky 232 px sidebar (brand, nav `groups` — the first unlabelled, the rest headed, each its own `<nav aria-label>` — with a per-item `badge`, then the `connection` and `user` slots) beside a 60 px topbar (`breadcrumb`, `actions` slots) and `<main>` (`flush` drops its padding). Below 768 px the sidebar becomes zero's modal `Drawer` (312 px, 50 px items, the same groups and foot behind a 44 px menu button) and the bar an app bar: `title` (the page), `back` (a detail route's parent, rendered through the `back` slot), the `subtitle` slot under the title and the `phoneAction` slot as the one right slot (else the last action). Router-agnostic: render your router's link in the `link` slot (it receives the item's `icon`); `currentPath` marks the active item. Import `@agentic/ui/shell.css` once. `ThemeToggle` is still exported for a design system with a light pair; the app does not render it (dark only).

```tsx
<ThemeProvider>
    <AppShell brand="agentic" groups={NAV_GROUPS} currentPath={route.path} flush={isChat}
        slots={{ link: ({ item }) => <Link to={item.href}>{item.label}</Link>, breadcrumb, actions, connection, user }}>
        <RouterView />
    </AppShell>
</ThemeProvider>
```

## Forms

`AgentForm`, `SchemaForm` and `EnvironmentCard` bind through zero's `model=` contract and also work without JS:

```tsx
<AgentForm model={() => state.config} tools={toolOptions} action="/agents/a1/config" onSubmit={({ config, reason }) => save(config, reason)} />
```

- The form edits a draft; a valid submit writes the config back through the model and emits `submit`. An invalid submit is blocked, errors render beside their fields (`Field.Error`, `role="alert"`, wired to the control by `aria-describedby`) and `invalid` fires; `reset()` restores the draft.
- Every control has a real `name` (see `AGENT_FIELDS`), so the form posts before hydration. On the server, `parseAgentFormData(formData)` returns the same config plus the validation errors. A form-level error (the count of fields needing attention, a write's refusal) is an `ErrorNote` marked `data-form-summary`.
- `SelectField virtual={virtualListbox}` (from `@sigx/zero/virtual-listbox`, with an optional `estimateItemSize`) windows a long list — the time-zone field. Its hidden `<select>` then carries only the chosen option, so pick another by the control (typeahead), not by writing the hidden select. Options with a `group` render under group headings.
- Persistence is the caller's: the forms emit, they never write to an actor.
- `AgentForm runtimes={…}` takes `RuntimeOption[]`: each runtime may carry a `hint` (drawn under the select, with an `href` to the fix) and the `models` its plugin lists — the model field is then a select (runtime default, each model, "Custom…" → a typed id posted as `AGENT_FIELDS.modelCustom`). Without `runtimes` the form offers the built-in pair and a typed model.
- `AgentForm layout="sections" approvalControl="segmented" slots={{ rail }}` is the Agent config page's shape (`docs/design/HANDOFF.md` → Agent config): two-column sections with a title-and-hint column, the approval policy as segmented controls (each posts its category through `Segmented name`), and the save card + versions rendered by the page inside the form through the `rail` slot (it receives the form API — `dirty()`, `reset()`, `submit()`, `draft` — and the bound `config`).

### Working-folder picker (#191)

`WorkdirField` and `WorkdirDialog` pick a `WorkdirRef` (`{ environmentId, path }`) on a remote machine. Both are data in and events out; the page owns browsing.

```tsx
<WorkdirField value={draft.workdir} environments={envs} name="workdir" onOpen={() => (ui.picking = true)} onClear={() => (draft.workdir = null)} />
<WorkdirDialog
    model={() => ui.picking}
    environments={envs}              // WorkdirEnvironment[] — toWorkdirEnvironment(descriptor, machine)
    recent={recent}
    environmentId={b.environmentId}  // null: none chosen yet
    path={b.path}                    // null: the environment's top level (Recent + Roots)
    listing={b.listing} loading={b.loading} error={b.error}
    creating={b.creating} worktreeError={b.worktreeError}
    onNavigate={({ environmentId, path }) => browse(environmentId, path)}   // fs.request list
    onCreateWorktree={(req) => createWorktree(req)}                         // fs.request worktree; then navigate / select the result
    onSelect={(ref) => (draft.workdir = ref)}                               // the dialog closes itself
/>
```

The dialog never fetches and never assumes that a move happened: it shows what `path` / `listing` say. It holds no `<form>` and no named control, so it can sit inside a page's form. `workdirLabel(ref, environments)` is the chip text for any other surface.

### Plugin setup (#232)

`SchemaForm` draws a plugin's config form from its core `ConfigSchema`; `SecretField` takes its secrets; `PluginCard` and `ReadinessBadge` show it in a list. All four are data in and events out — the page owns the Registry calls.

```tsx
<SchemaForm schema={plugin.manifest.config} value={plugin.config} saving={st.saving} error={st.error} onSubmit={(config) => configure(plugin.manifest.id, config)} />
{(plugin.manifest.secrets ?? []).map((s) => (
    <SecretField name={s.name} label={s.title} description={s.description} required={s.required} isSet={secretNames.includes(s.name)} onSave={(value) => setSecret(s.name, value)} onRemove={() => deleteSecret(s.name)} />
))}

<PluginCard id={m.id} name={m.name} kind={m.kind} version={m.version} description={m.description} readiness={pluginReadiness(plugin, facts)} active={active.memory === m.id} slots={{ toggle, meta, configure }} />
```

- One field per property: string → text (`format: 'uri'` → URL), `enum` → select, number / integer → number (`minimum` / `maximum`), boolean → switch, string list → chips, string map → `MapField` rows. A property kind the form does not know is not drawn and is kept in the config. Validation is core's `validateConfig`, read over `configDefaults`.
- `submit` emits a SPARSE config: a property left at its manifest default is not written, so the stored config keeps following the manifest. Write it as it comes.
- `value` follows a live read while the draft is clean; an edited draft is never overwritten. `ref` gives `dirty()`, `reset()`, `submit()`, `errors()`, `draft`; `hideActions` leaves the buttons to a save rail.
- `SecretField` never shows a value and never posts one: the input has no `name`, is disabled until mounted, and the typed value is dropped when `save` fires. Put it BESIDE `SchemaForm`, never inside another `<form>`. After a failed write the user pastes again.
- `ReadinessBadge readiness={…} detail` adds the sentence (`readinessDetail`) after the pill; `READINESS` is the label / tone table.

## Component kit (`src/kit`)

The app components of `docs/design/HANDOFF.md` → "Components", one visual per domain state. The `ag-*` scopes ship in the fragment with recipes (`kitAnatomies` is the list; among them `StatusPill` / `Tag` / `WaitReasonLine` on `ag-pill`, `AgentTile`, `EnvironmentLine`, `NeedsItem`, `TaskNode`, `ConnectionStrip`, `VersionItem`, `EnvironmentCard` on `ag-env-card`, `MarkdownViewer` on `ag-markdown`); the rest compose zero (`Button`, `Segmented`, `Switch`, `ChipInput`, `DataTable`, `TimelineList`, `ConfirmDialog`, `FormDialog`, `MarkdownDialog`, `ErrorNote`, `SectionHeading`, `Label`, `Icon`). Product state never rides `data-state`: a colour is the `tone` axis (`data-tone`), an inbox row's kind the `kind` axis, presence flags are `data-mod-*`.

- `MarkdownViewer value` is a document as prose: the `ag-markdown` recipe styles what `@sigx/richtext/dom` renders inside it (`data-scope="richtext"`; `@sigx/richtext` ships no stylesheet) — headings, lists and task boxes, blockquotes, code blocks with a language / copy header, tables, links (`_blank`, or `onLink`), images. Code highlights through one shared shiki highlighter (`markdownHighlighter()`, loaded on the first block, plain text on any failure); `highlighter={false}` keeps it plain (tests). `compact` is the card-well size.
- `Button intent` renders zero's `Button.Root` with the intent's axes (`data-intent` for the kit's own rules); `type`, `form`, `name`, `value`, `label` (`aria-label`) and `onClick` pass through. `loading` is zero's: `data-state="loading"`, `aria-busy`, `aria-disabled` and the `spinner` part, activation blocked but NOT the native `disabled`, so the pressed button keeps focus. `href` renders a real `<a>` through `Button.Root asChild` with the same axes — a link button (the web app's `LinkButton` adds the router push).
- `Segmented name form` posts the chosen value through zero's `ToggleGroup` hidden `<select>`: no hand-written hidden input beside it.
- `ConfirmDialog` is the destructive confirm (`role="alertdialog"`, initial focus on Cancel). `cancel` fires on every close the caller did not make (zero's close reason is not `programmatic`: Cancel, Escape); the confirm button does not close, the caller closes by writing the model after `busy`.
- `FormDialog model title description submitLabel cancelLabel busy` is data entry: a plain modal `Dialog` around a `<form>` (default slot = the fields), so Enter submits, `required` validates and focus lands on the first field. `submit` keeps it open until the caller writes the model; `cancel` fires on Cancel, Escape and a backdrop click (a plain modal light-dismisses).
- `ErrorNote title` is an error line on zero's `Alert` (`role="alert"`, error colour, small); pass the site's `data-*` hook (`<ErrorNote data-save-error="">`) and it lands on the alert root.
- `MarkdownDialog model title value` reads a document full-size: zero's `Dialog` at 880 px, the viewer scrolling between the title and the footer, the `footer` slot's actions before `Close`; every close (Close, Escape, backdrop, or the model set false after a footer action) emits `close`. The plan card opens its plan in it.

```tsx
import { AgentTile, Button, DataTable, EnvironmentLine, StatusPill, WaitReasonLine } from '@agentic/ui';

<DataTable cols="100px 1fr 140px 270px 60px" columns={[{ label: 'Status' }, { label: 'Objective' }, { label: 'Assignee' }, { label: 'Environment' }, { label: 'Age', align: 'end' }]} label="Active tasks">
    <DataTable.Row>
        <DataTable.Cell><StatusPill status={task.status} />{task.wait && <WaitReasonLine wait={task.wait} detail="git push" />}</DataTable.Cell>
        <DataTable.Cell><a href={`/tasks/${task.id}`}>{task.objective}</a></DataTable.Cell>
        <DataTable.Cell><AgentTile name="Forge" hue={2} size={22} /> Forge</DataTable.Cell>
        <DataTable.Cell><EnvironmentLine machine="alien01" runtime="claude-code" account="work" /></DataTable.Cell>
        <DataTable.Cell>14m</DataTable.Cell>
    </DataTable.Row>
</DataTable>
<Button intent="wait" icon="check">Allow once</Button>
```

`PILLS` is the table: if core gains a state, add its row there before it reaches a screen. `Button intent="icon"` needs a `label`; `EnvironmentLine` refuses a lone part in development (EXE-06); `DataTable` refuses a template that does not match its columns.

### Provider limits (#270)

Two components show what Claude Code's `/usage` shows, for any provider:

- **`QuotaMeter`** (`ag-quota`) draws one `QuotaWindow`:
  - the bold label
  - an 8 px bar coloured by status (`ok` → `live`, `warning` → `needs-you`, `exhausted` → `failed`, `unknown` → `muted`)
  - "76% used"
  - "Resets Sep 22 at 8pm (Europe/Stockholm)" in the viewer's zone (time only when it resets today)
- **`QuotaPanel`** (`ag-quota-panel`) draws one account's `QuotaSnapshot` or `null`:
  - the title, plan tag and age
  - the windows, all of them or with `compact` only the tightest
  - a panel older than `QUOTA_STALE_MS` (30 min) is `stale`, which dims the meters and turns the age warning
  - `not-reported` reads "Not reported by provider — <reason>" and `null` reads "No usage reported yet", never an empty bar (OPS-07, PLG-09)
  - with `zoneInHeader` (#452) the zone is said once at the header's end and each window reads "Resets Thu 25 Sep 12:00"
- **`QuotaBadge`** is one compact line for wherever an account is chosen; given `model`, it picks the tightest window of `memberWindows` — another model's week is never the member's limit (#452).
- **`QuotaRings`** (`ag-quota-rings`, #452) draws a chat member's limits as 28 px rings for the session and week windows of `memberWindows(snapshot, model)`, each with its percent and label (`12% SESSION`, `100% FABLE`); `role="progressbar"` per ring.
- **`EnvironmentCard`** takes an optional `quota` prop and shows the panel under the facts.
- The helpers `resetsText`, `resetsShortText`, `quotaUsedText`, `quotaTone`, `ageText` and `isQuotaStale` are exported.

### Session files and changes (`src/code`, #563)

The parts of a session's Changes and Files views (`docs/design/HANDOFF.md` → "Session files and changes"). They take core's VCS-neutral types (`ChangedFile`, `ChangeCommit`, `FsTreeEntry`) and never know where the files come from.

- **The code surface is pluggable.** Pages render **`CodeViewer`** (one read-only file: `text`, `path`, `lineMarks` for the 3 px change stripe, `selected` / `onLineSelect`, `lineWidget`, `revealLine`) and **`CodeDiff`** (`original`, `modified`, `path`, `mode: 'unified' | 'split'`, `selected: LineRef`, `onLineSelect`, `lineWidget`); the renderer in effect draws them.
  - **`useCodeRenderer`** resolves it: a subtree's `CodeRendererProvider`, the app's `app.defineProvide(useCodeRenderer, () => renderer)`, else Monaco. Any `{ id, Viewer, Diff }` taking these props is a renderer.
  - **`monacoCodeRenderer`** (the default) draws the plain grid first — the SSR markup, what stays without JavaScript or when Monaco cannot load — imports its engine on mount, and swaps the editor in once ready. The diff collapses unchanged stretches, splits with `mode`, and mounts `lineWidget` in a view zone under the selected line. Its theme is `monacoTheme(palette)`, built from the design system's tokens; nothing hard-codes a colour. Monaco itself comes from `@sigx/monaco-editor`'s prebundled assets, which the app serves at `/monaco-bundle`.
  - **`plainCodeRenderer`** is the numbered grid of the boards (`56px 3px 1fr` viewer, `48px 48px 20px 1fr` unified diff, two halves split). Tests provide it: happy-dom has no Monaco.
  - The line diff behind it is exported: `diffLines`, `unifiedRows`, `splitRows`, `changedLines` (the Files view's stripes: working lines that differ from HEAD) and `hunkAt` (the hunk around a line, what "Ask about a line" attaches).
- **`ChangesPanel`** (`ag-changes`) holds **`ChangeList`** (a group of 40 px file rows: `StatusTile`, name over its folder truncated from the start, `DiffCounts`; links from `href(file)`, `aria-current` on `current`, totals in the heading, an `empty` line) and **`CommitList`** (message, `short · time`, the author's tile from `author(commit)`), with the read-only `note` at the foot.
- **`SessionBar`** (`ag-session-bar`): link tabs with counts (`aria-current="page"` on the open one), the agent tile, `machine / account`, the branch chip, "n ahead of base", and the view's controls in the default slot. It wraps below 768 px.
- **`FileHeader`** (`ag-file-header`): status tile, the path as `dir/name` or spaced `breadcrumbs`, counts or `facts`, actions in the slot.
- **`LineComposer`** (`ag-line-composer`): "Ask <agent> about line n", `file:line`, a textarea (Ctrl/Cmd+Enter sends, Escape cancels), the "Posts to …" note, Cancel and Send. It only collects the question; posting is the caller's.
- **`GoToFile`** (`ag-find`): zero's `Combobox` over known paths, every match ranked by `findPaths` (subsequence matches in the file name first) and windowed with `virtual={virtualListbox}`, so a folder of thousands of files keeps a page of options in the DOM; `hotkey` focuses it on Ctrl/Cmd+P; `id` (default `ag-find`) lands on its root. **`Kbd`** is zero's `Kbd` with the keys as a `keys` prop.
- **`FileTree`** (`ag-file-tree`) and **`FileTreeLegend`**: zero's `TreeView` (the APG tree: roving focus, arrow keys, typeahead, `aria-level`), each row an `ag-file-tree` `item` rendered `asChild` over TreeView's item or branch trigger. A folder loads through `load(path)` when it is expanded (`expandedValuesChange`) and its children render once they arrive; the ancestors of `selected` open on mount; `version` reloads; Enter or a click on a folder opens it, on a file calls `onSelect`.

### States (`src/kit/states`)

The handoff's failure, empty and loading states, one component each, so no page invents "Something went wrong" (OPS-04, OPS-05). `FailureCard kind=…` renders one of the six named states on `ag-failure` — `client-offline`, `machine`, `auth`, `runtime`, `task`, `interrupted` — each with its own name, icon, mono signal caption, tone and action, all from the `FAILURES` table (`kit/states/kinds.ts`, shared with the inbox row's kinds); `data-kind` carries the design system's axis spelling (`client-offline` → `offline`). `OfflineBanner` (`ag-banner`) is the "This browser is offline · Reconnecting…" strip over the content; `EventsLostRow` the amber "Events lost between seq A and B" line in a session log; `browserRow` / `machineRow` / `connectionRows` turn the two signals into `ConnectionStrip` rows (hollow dot when nothing is happening). `EmptyState variant=…` (`ag-empty`) is the workspace card, the inbox line, the dashed machines card, the chat hint, or a generic title + caption. `TableSkeleton` / `CardSkeleton` / `RailSkeleton` stand in while data loads, one `aria-busy` region with a hidden "Loading" each. Mapping live signals to these is #46's job.

```tsx
import { FailureCard, EmptyState, TableSkeleton, connectionRows } from '@agentic/ui';

<FailureCard kind="machine" detail="alien01 stopped answering." action={{ href: '/machines/m1' }} />
<EmptyState variant="inbox" />
{loading ? <TableSkeleton cols="100px 1fr 60px" /> : table}
<ConnectionStrip rows={connectionRows('live', machines)} />
```

## Transcript (`src/thread`) and composer (`src/composer`)

Driven by a reactive `AgentTranscript` — `useAgentSession(session).transcript` or anything the `@sigx/ai-agent` reducer folds in place. Each part is its own component, so a streaming delta re-renders one part. The visuals are `docs/design/HANDOFF.md` → "`ai-*` fragment", "Tool call `data-state`", "Approvals".

- `Thread` windows its rows: at most `window` parts (default 150) in the DOM; it opens at the bottom and follows the tail while the reader is there (`data-state="on"`) — pinned on mount, after each render and on every resize of its list, with instant (never smooth) scrolling — and only a scroll UP past `threshold` pauses it, freezing the window, shows the "Showing the last N entries · Load earlier" chip and the "Jump to latest" anchor. A host that holds rows before the transcript's first (a chat paging its older entries from a store) passes `hasEarlier` and `onEarlier`: the chip stays once the window is fully open, and reaching the top — the chip, or a scroll to within `threshold` of it — calls `onEarlier` once per approach; rows the host then prepends keep the frozen rows in place (the window's end moves with them, the scroll offset absorbs the new height). `describe(message)` tells it who an author is (`MessageAuthor`: `name`, `hue`, `person`, `environment`, `time`); `toolMeta(part)` gives a card its meta; `logHref` is where long outputs link. The last assistant row carries the STREAMING pill while the session is mid-turn (`midTurn`).
- `Message` is a row: the kit's `AgentTile` (32 px; the user's own rows are person circles) top-aligned, then the meta line — `name`, `environment` (kit `EnvironmentLine`, text-dim), `time` — the body and the tool cards.
- `ToolCall` paints the lifecycle on zero's governed states — `loading` (pending, awaiting approval), `active` (running), `complete`, `error` (failed, cancelled), `closed` (denied) — with the handoff's word on a `StatusPill` in `status` (PENDING · RUNNING · DONE · ERROR · DENIED) and the refined phase (`awaiting approval`, `cancelled`, `done, no output`) as the header `meta` when the caller gave none (andtii/zero-wip#483). The border takes a colour only while `active` and on `error`. The output well shows six lines, then "Show N more lines" (`more`); past 200 lines the rest is in the session log (`log`, needs `logHref`).
- `Reasoning` folds to "Reasoning · Ns" behind a chevron once done (`seconds`), open while it streams; the reader's toggle wins.
- `ApprovalPrompt` is the approval card: header with the `rule`, the request well (tool + `input` verbatim), the context rows (`requestedBy`, `environment`, `via`; dropped by `compact`) and three decisions — `Allow once` (amber), `Allow for this session`, `Deny` — sent as `onRespond(requestId, { type: 'permission', outcome, scope })`, exactly what `session.respond()` takes. Buttons disable and the chosen one spins until the request resolves; pass `decision` and the card collapses to the one-line `record` (`decisionText`). Plan mode's `ExitPlanMode` request is the same card with the plan in the well (`MarkdownViewer compact`), `Open plan` reading it full-size in a `MarkdownDialog` with the same answers — `Approve · default` / `Approve · accept edits` (an allow naming the mode in `options.permissionMode`) and `Keep planning` (a deny with `KEEP_PLANNING_MESSAGE`).
- `Message` renders an `image` part as a lazy thumbnail (at most 320 px, `alt` = its name) that opens full size in a new tab, and a `file` part as a download chip — icon, name, size (given, or decoded from the base64 length).
- `Composer` takes files by the Attach button's picker (`accept`), by paste and by drag-and-drop, and emits them as `files(File[])` — the host uploads and passes back `attachments` (`{ id, name, size?, status?: 'uploading' | 'ready' | 'error', error?, previewUrl? }`); chips show a thumbnail, a spinner while uploading, the error, and remove (`removeAttachment(id)`). Send waits while anything is uploading and goes with an empty draft when there are attachments. `prepareImage(file, { maxEdge, quality })` shrinks an image before upload (WebP, else JPEG, only when smaller; GIF / SVG untouched; the original on any failure).
- `ToolCall` takes `links` (`{ label, href }[]`, the header's `link` part before the meta) — a page's own links about a call, e.g. "View diff" (#565); `Thread` / `Message` pass them through `toolLinks(part)`.
- `Composer` takes `insert` (`{ id, text }`): each new `id` appends `text` to the draft (spaced, caret after it, focus without scrolling), also on mount — how a page opened to "Mention in chat" puts `@file:<path>` in (#565). It emits `draft(text)` after an insert; typing still reports through the DOM `input` event.
- `Composer` emits `send(text)`, `cancel` and `attach`; pass `busy` / `steers` / `canCancel` from the agent's capabilities, `mentions` for the `@` popup, and `recipients` + `hint` for the "To" row (an empty list says nobody will answer — the page resolves who, per CHT-06).

```tsx
const view = useAgentSession(session);

<Thread transcript={view.transcript} onRespond={(id, d) => void view.respond(id, d)}
    onCancelAgent={(id) => void view.cancelAgent(id)}
    describe={(m) => agents.byName(m.actor)} logHref={`/sessions/${view.transcript.sessionId}`} />
<Composer busy={view.state === 'running' || view.state === 'awaiting'}
    steers={view.capabilities?.steer} canCancel={view.capabilities?.cancel}
    recipients={[{ id: 'atlas', name: 'Atlas', hue: 1, role: 'coordinator' }]} hint="Atlas answers unless you @ someone"
    onSend={(text) => void view.prompt(text)} onCancel={() => void view.cancel()} />
```

## Fragment (`@agentic/ui/fragment`)

The six `ai-*` anatomies (and the kit's `ag-*`) as a zero manifest fragment plus a recipe pack on the recommended token grammar — the handoff's inks (`--ag-line`, `--ag-text-dim`, …) are read with a recommended fallback, so a generic skin still renders it — pure data (no sigx runtime). `fragmentCss` carries the one `@keyframes` (the streaming pulse) for the design system's raw-CSS slot. Declared through `"sigx-zero": { "fragment": "./dist/fragment.js" }`; `build` also writes `dist/fragment.json` for `--extra-manifest`. A design system adopts it with `mergeManifests(zeroManifest, fragment)` + `recipes`, or `sigx zero:extend` once a kit carrying it is published (andtii/zero-wip#482). `__tests__/fragment.test.ts` runs the `zero:fragment` checks until then.
