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

`withOverride(recipes, scope, patch)` replaces a daisy recipe in place with the patch deep-merged (arrays and scalars replace, `compoundVariants` append) — one recipe per scope, never two. Validate with `sigx zero:validate ./node_modules/@agentic/ui/dist/design-system.js --extra-manifest ./node_modules/@agentic/ui/dist/fragment.json` (the web app's build does).

## Layout tier (`src/layout`)

Stand-in for zero's layout tier until a release ships it (andtii/zero-wip#473 landed on main). `Stack`, `Row`, `Col` render one `data-scope="stack"` carrier with `data-orientation`; `Spacer` takes the free space. Layout facts are `data-l-*` attributes whose values are the design system's `--space-*` ramp (`gap`, `pad`) or flex keywords (`align`, `justify`, `wrap`, `grow`); per-breakpoint overrides put the breakpoint in prefix position (`at={{ md: { gap: 'lg' } }}` → `data-l-md-gap="lg"`). Import `@agentic/ui/layout.css` once. `useMediaQuery(query)` is the SSR-safe `matchMedia` signal.

```tsx
import { Row, Col, Spacer } from '@agentic/ui';

<Row gap="md" align="center" at={{ md: { gap: 'xl' } }}>
    <Col grow>…</Col>
    <Spacer />
    <button>Save</button>
</Row>
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

`AgentForm`, `ConfigVersions`, `EnvironmentCard` and `SettingsForm` bind through zero's `model=` contract and also work without JS:

```tsx
<AgentForm model={() => state.config} tools={toolOptions} action="/agents/a1/config" onSubmit={({ config, reason }) => save(config, reason)} />
```

- The form edits a draft; a valid submit writes the config back through the model and emits `submit`. An invalid submit is blocked, errors render beside their fields (`Field.Error`, `role="alert"`, wired to the control by `aria-describedby`) and `invalid` fires; `reset()` restores the draft.
- Every control has a real `name` (see `AGENT_FIELDS` / `SETTINGS_FIELDS`), so the form posts before hydration. On the server, `parseAgentFormData(formData)` / `parseSettingsFormData(formData)` return the same config plus the validation errors.
- Persistence is the caller's: the forms emit, they never write to an actor.
- `AgentForm runtimes={…}` takes `RuntimeOption[]`: each runtime may carry a `hint` (drawn under the select, with an `href` to the fix) and the `models` its plugin lists — the model field is then a select (runtime default, each model, "Custom…" → a typed id posted as `AGENT_FIELDS.modelCustom`). Without `runtimes` the form offers the built-in pair and a typed model.
- `AgentForm layout="sections" approvalControl="segmented" slots={{ rail }}` is the Agent config page's shape (`docs/design/HANDOFF.md` → Agent config): two-column sections with a title-and-hint column, the approval policy as segmented controls, and the save card + versions rendered by the page inside the form through the `rail` slot (it receives the form API — `dirty()`, `reset()`, `submit()`, `draft` — and the bound `config`).

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

The app components of `docs/design/HANDOFF.md` → "Components", one visual per domain state. Eight `ag-*` scopes ship in the fragment with recipes (`StatusPill` / `Tag` / `WaitReasonLine` on `ag-pill`, `AgentTile`, `EnvironmentLine`, `NeedsItem`, `TaskNode`, `ConnectionStrip`, `VersionItem`, `EnvironmentCard` on `ag-env-card`); the rest compose zero (`Button`, `Segmented`, `Switch`, `ChipInput`, `DataTable`, `TimelineList`, `ConfirmDialog`, `SectionHeading`, `Label`, `Icon`). Product state never rides `data-state`: a colour is the `tone` axis (`data-tone`), an inbox row's kind the `kind` axis, presence flags are `data-mod-*`.

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

- `Thread` windows its rows: at most `window` parts (default 150) in the DOM; it follows the tail while the reader is at the bottom (`data-state="on"`), freezes the window on scroll-up, shows the "Showing the last N entries · Load earlier" chip and the "Jump to latest" anchor. `describe(message)` tells it who an author is (`MessageAuthor`: `name`, `hue`, `person`, `environment`, `time`); `toolMeta(part)` gives a card its meta; `logHref` is where long outputs link. The last assistant row carries the STREAMING pill while the session is mid-turn (`midTurn`).
- `Message` is a row: the kit's `AgentTile` (32 px; the user's own rows are person circles) top-aligned, then the meta line — `name`, `environment` (kit `EnvironmentLine`, text-dim), `time` — the body and the tool cards.
- `ToolCall` paints the lifecycle on zero's governed states — `loading` (pending, awaiting approval), `active` (running), `complete`, `error` (failed, cancelled), `closed` (denied) — with the handoff's word on a `StatusPill` in `status` (PENDING · RUNNING · DONE · ERROR · DENIED) and the refined phase (`awaiting approval`, `cancelled`, `done, no output`) as the header `meta` when the caller gave none (andtii/zero-wip#483). The border takes a colour only while `active` and on `error`. The output well shows six lines, then "Show N more lines" (`more`); past 200 lines the rest is in the session log (`log`, needs `logHref`).
- `Reasoning` folds to "Reasoning · Ns" behind a chevron once done (`seconds`), open while it streams; the reader's toggle wins.
- `ApprovalPrompt` is the approval card: header with the `rule`, the request well (tool + `input` verbatim), the context rows (`requestedBy`, `environment`, `via`; dropped by `compact`) and three decisions — `Allow once` (amber), `Allow for this session`, `Deny` — sent as `onRespond(requestId, { type: 'permission', outcome, scope })`, exactly what `session.respond()` takes. Buttons disable and the chosen one spins until the request resolves; pass `decision` and the card collapses to the one-line `record` (`decisionText`).
- `Message` renders an `image` part as a lazy thumbnail (at most 320 px, `alt` = its name) that opens full size in a new tab, and a `file` part as a download chip — icon, name, size (given, or decoded from the base64 length).
- `Composer` takes files by the Attach button's picker (`accept`), by paste and by drag-and-drop, and emits them as `files(File[])` — the host uploads and passes back `attachments` (`{ id, name, size?, status?: 'uploading' | 'ready' | 'error', error?, previewUrl? }`); chips show a thumbnail, a spinner while uploading, the error, and remove (`removeAttachment(id)`). Send waits while anything is uploading and goes with an empty draft when there are attachments. `prepareImage(file, { maxEdge, quality })` shrinks an image before upload (WebP, else JPEG, only when smaller; GIF / SVG untouched; the original on any failure).
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
