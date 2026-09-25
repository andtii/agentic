# Promotion candidates

Work that starts in this repo but is generic. Each row gets a `promote` label on its issue and a line here, so lifting it into the sigx estate later needs no archaeology. Nothing here goes upstream until it has stabilised in this app.

| Piece (here) | Lands in | When |
|---|---|---|
| DO-backed `EventLogStore` / `TranscriptStore` (`packages/platform/src/session`) | signalxjs/ai `@sigx/ai-actors` (signalxjs/ai#19) | after v1 stabilises |
| MCP client (`packages/mcp/src/client`: Streamable HTTP over fetch, tool mapping, capability report; stdio in `packages/mcp/src/node`) | `@sigx/ai-agent/harness` (+ `@sigx/ai-agent-node` for stdio) | after resources/prompts are added |
| A2A server + client adapter (`packages/a2a`) | `@sigx/ai-agent-a2a` | after the conformance subset passes |
| Memory / Learning interfaces (`packages/core`) | `@sigx/ai-agent` (`./memory`) | once two implementations exist |
| BM25-ish memory ranking + versioned NDJSON export (`packages/memory/src/rank`, `src/export`) | `@sigx/ai-agent` (`./memory`), beside the interfaces | once a second MemoryPlugin exists |
| Permission-free proposal guard + lesson helpers (`packages/learning/src/proposals`, `src/lessons`) | `@sigx/ai-agent` (`./memory`), beside the Learning interfaces | once a second LearningPlugin exists |
| DelegateTool (`packages/runtimes/src/tools/delegate.ts`) | `@sigx/ai-agent` | after limit semantics settle |
| Approval-rule policy compiler + `constrainPolicy` (stricter side wins across delegation) (`packages/platform/src/policy`) | `@sigx/ai-agent` policy rules | once a second consumer of `ApprovalRule` exists |
| Daemon-protocol envelope + relay (`packages/daemon-protocol`, `apps/daemon`) | `@sigx/ai-agent/wire` + `@sigx/ai-agent-node` | later |
| `compareVersions` / `isVersion` (dependency-free semver order) in `packages/daemon-protocol/src/release.ts` (#360) | a small sigx utility, once a second package needs it | later |
| A `draining` wire error code (today `busy` + a `draining:` message, `drainingReply`, #360) | `@sigx/ai-agent/wire` `WireErrorCode` | later |
| NDJSON `EventLogStore` with platform-keyed files + reconnecting bearer WebSocket with backoff (`apps/daemon/src/event-log.ts`, `src/connection.ts`) | `@sigx/ai-agent-node` | when a second Node host needs them |
| `ai-thread` / `ai-message` / `ai-composer` / `ai-tool-call` / `ai-reasoning` / `ai-approval` fragment + recipe pack, part-windowed `Thread`, `@mention` model (`packages/ui/src/{thread,composer,fragment}`) | signalxjs/ai `@sigx/ai-ui` (signalxjs/ai#17) | soon — generic from day one |
| `Thread` host paging — `hasEarlier` / `onEarlier` (the chip stays once the window is open, reaching the top asks once per approach) and the prepend correction (the frozen window's end moves with prepended rows, the scroll offset absorbs their height) (`packages/ui/src/thread/Thread.tsx`, #398) | with the `Thread` above | with it |
| Chat-file serving rules — `X-File-Name` cleaning (decode, last path segment, no control characters, capped), media-type essence parsing, `Content-Disposition` inline-only-for-raster with an RFC 5987 name, and the download hardening headers (`apps/web/src/files/route.ts`); `r2ChatFileStore` (metadata-in-R2, bounded resumable orphan sweep, `apps/web/src/files/store.ts`) | `@sigx/actors-cloudflare` (an R2 blob store beside the Durable Object storage) or `@sigx/server` (a hardened download response helper) | when a second app serves user uploads |
| `prepareImage` — downscale a picked image to a max edge with `createImageBitmap` + `OffscreenCanvas` (canvas fallback), re-encode as WebP / JPEG only when smaller, GIF / SVG untouched, the original on any failure (`packages/ui/src/composer/prepareImage.ts`) | `@sigx/zero` beside `FileUpload`, or signalxjs/ai `@sigx/ai-ui` | when a second upload surface needs it |
| `ag-*` component kit — status pill / tag, agent tile, environment line, needs item, task node, connection strip, version item, environment card, plus `Button` intents, `Segmented`, `DataTable`, `ConfirmDialog` (`packages/ui/src/kit`) | signalxjs/ai `@sigx/ai-ui` beside the `ai-*` fragment (signalxjs/ai#17) | after the pages stabilise on it |
| `ag-markdown` prose recipe over `@sigx/richtext`'s parts (`data-scope="richtext"`) + `MarkdownViewer` (shared lazy shiki highlighter, `compact`) + `MarkdownDialog` (an 880 px document dialog with a footer slot) (`packages/ui/src/kit/{MarkdownViewer,MarkdownDialog}.tsx`, `kit/recipes.ts`, #490) | `@sigx/richtext` as its styling recipe / a zero `richtext` scope, or `@sigx/ai-ui` | when a second document surface uses it |
| `policyConverged` / `policyRootKey` — compare a desired set of roots with a machine's report by spelling only (`~` literal, separators unified, case folded per OS), never expanding a home directory off the machine (`packages/core/src/workdir.ts`, #480) | a small sigx path utility beside `pathWithin` | when a second app keeps a desired/reported pair |
| Step-up elevation — `sealElevation` / `openElevation` / `elevationFromRequest` / `requireElevated` over a second `__Host-*` cookie honoured only for the session's own user, plus the page-side pending-change round trip (`packages/platform/src/auth/elevation.ts`, `apps/web/src/pages/machines/elevate.ts`, #478) | `@sigx/server` beside the session seal | when a second app needs a re-confirm step |
| Schedule / timezone reminder actor (`packages/platform/src/schedule`) | `@sigx/actors-workflow` schedule actor (signalxjs/actors#390) | later |
| Shared harness driver pieces — platform tools bridged through `callTool`, daemon-side MCP connectors with credential fetch and cwd-root check, platform-run connector tools served from declarations and called back over `callTool` (#534), `profileEnv`, the capability report and session guards (`packages/runtimes/src/harness`) | `@sigx/ai-agent-node` | when a harness adapter outside this repo needs them |
| Copilot CLI adapter — `@github/copilot-sdk` session events → the event wire, permission / user-input callbacks → the turn's `ctx.resolve` (`TurnContext.resolve`), client tools with policy in the handler, `account.getQuota` → quota windows (`packages/runtimes/src/copilot-cli`) | `@sigx/ai-agent-copilot-cli` | once a second app drives Copilot |
| Codex `codex app-server` adapter — JSON-RPC client and handshake, the item/approval/steer/interrupt mapping onto `AgentEvent`s, and client tools over loopback MCP gated by the session policy (`packages/runtimes/src/codex-cli`: `client.ts`, `agent.ts`, `protocol.ts`) | `@sigx/ai-agent-codex-cli` | once a second app drives Codex |
| Codex usage-limit mapping — `account/rateLimits/read` / `rateLimits/updated` primary and secondary windows as a `QuotaSnapshot` (`packages/runtimes/src/codex-cli/quota.ts`) | `@sigx/ai-agent-codex-cli`, next to the adapter | with the adapter |
| Claude Code profile isolation + doctor (`packages/runtimes/src/claude-code`: per-profile child env, shared-config-dir check, credentials-file auth status) | `@sigx/ai-agent-claude-code` | once validated on macOS |
| `ConfigSchema` + `validateConfig` / `configDefaults` — a typed JSON-Schema subset (string / enum / uri, number, boolean, string list, string map) with a zero-dependency validator that reports `{ path, message }` per field (`packages/core/src/plugin-config.ts`) | `@sigx/ai-agent` beside the tool-input schemas, or `@sigx/zero` with a schema form | when a second consumer needs a settings schema |
| Git project feature plugin — detect on the git badge, origin identity, `## Project` instructions, a deterministic branch + worktree per chat through the daemon's `worktree` op (`packages/plugins-git`) | `@sigx/ai-agent/coding` beside the folder helpers | once a second app uses project feature plugins |
| `pathWithin` / `normalizePath` — pure, OS-aware lexical "is this path inside one of these roots" check, plus `suggestWorktreePath` (`packages/core/src/workdir.ts`) | `@sigx/ai-agent/coding` beside `isWithin` (which needs `node:path`) | when a second edge consumer needs it |
| Remote folder picker — controlled `WorkdirDialog` (environment strip, breadcrumb from a root, listbox with Backspace-up, git badges, inline new-worktree form) and `WorkdirField` chip (`packages/ui/src/forms/workdir-*.tsx`) | signalxjs/ai `@sigx/ai-ui` beside the `ai-*` fragment (signalxjs/ai#17) | once a second app browses a daemon's folders |
| Schema-driven config form — `SchemaForm` over a typed JSON-Schema subset, with the sparse draft model (`packages/ui/src/forms/schema-form.tsx`, `schema-model.ts`) and the write-only `SecretField` (`packages/ui/src/plugins/SecretField.tsx`) | `@sigx/zero` forms (a `SchemaForm` over `Field`), with core's `validateConfig` beside it | once a second app renders settings from a schema |
| `QuotaWindow` / `QuotaSnapshot` normalization + `mergeQuota` / `tightestWindow` — provider limits as windows with 0..1 utilization, reset time and status (`packages/core/src/quota.ts`) | `@sigx/ai-agent` beside `Usage` | when a second provider plugin or app reports limits |
| Claude Code rate-limit / usage mapping — `rate_limit_event` → one window, the experimental `/usage` answer → a snapshot, the unprompted probe query (`packages/runtimes/src/claude-code/quota.ts`) | `@sigx/ai-agent-claude-code` (an `ext` → quota helper and a `usage()` on the agent) | once the SDK's usage API is stable |
| Pricing table for Anthropic models (`packages/runtimes/src/anthropic/pricing.ts`) | `@sigx/ai-anthropic` | when a second consumer appears |
| Server-app stamp in both Worker halves (`apps/web/src/actors.app.ts` `ensureServerApp`: `createServerApp` before `super()` in the `ActorHost` constructor so principals decode after the hop) | `@sigx/actors-cloudflare` `createHostDurableObject({ serverApp: (env) => … })` / `createWorkerHandler` | when a second Cloudflare app needs it |
| Per-object host scope for `createHostDurableObject` (`apps/web/src/host-scope.ts`: `__SIGX_ACTOR_HOST__` as an accessor over an `AsyncLocalStorage`, `runWithHost` around `fetch` / the hibernation handlers / `alarm`, and around the Worker's requests) | `@sigx/actors` `seam.ts` — `currentHost()` consults an ALS that `createHostDurableObject` / `createWorkerHandler` enter at every entry point, global as the fallback | now — the seam is the right home (signalxjs/actors#456) |
| OAuth 2.1 authorization server + DCR for MCP clients (`packages/platform/src/auth/oauth-server`: RFC 8414/7591/9728 metadata, PKCE S256, consent transaction, sealed access/refresh/code tokens with rotation + replay revocation, `OAuthStore` port) and the per-principal MCP tool handler with annotation hints (`packages/mcp/src/server/handler.ts`) | `@sigx/ai-agent/harness` beside `createMcpToolHandler` (the OAuth server as an `@sigx/server` auth module) | after a second MCP-serving app needs it |
| CLI launcher installation (`apps/daemon/src/launcher.ts`: a launcher that hard-codes the resolved Node and install folder, the least-invasive route onto `PATH` per OS — link into a folder already on `PATH`, fenced shell-profile block, Windows user `PATH` — and the removal of all three) | a Node CLI shipped as an unpacked folder rather than through npm, so any sigx tool with an installer | when a second such tool ships an installer |
| `SessionRef` identity (`sameRefIdentity` in `apps/daemon/src/daemon.ts` and `packages/platform/src/session/actor.ts`: two refs name the same runtime session by `id` and `data.epoch`, never by reference — an adapter's `ref` may be a getter that builds a fresh object per read) | `@sigx/ai-agent` beside `SessionRef` | now — it is defined twice here (#389) |
| Reminder-driven retry of a parked hand-over (`deliverAnswers` + `armAnswers` in `packages/platform/src/session/actor.ts`: an item stays in the actor's queue with `attempts` / `nextAt`, a backoff table by attempt, one `ctx.reminders` entry for the earliest due item that restarts the actor task, the failure said only once the attempts are spent; `AnswerDeliveryError` in `routing/answers.ts` names the failed step and carries what earlier steps already did) | `@sigx/actors` as a `retryQueue(ctx, name, { delays, attempts })` helper over `ctx.reminders` + `ctx.tasks` | when a second actor retries a hand-over this way (#396) |
| Paged `TranscriptStore` over small records (`pageMessages` + `SessionTranscriptPage` in `packages/platform/src/session/store.ts`, `transcript.ts`: messages cut into ~512 KB pages, each fingerprinted by count / bytes / first / last id so a save rewrites only the tail) and the NDJSON log's `slice` / `retain` (`apps/daemon/src/event-log.ts`: a cursor range answered with `more`, retention that keeps whole turns under a byte budget and names what it forgot) | signalxjs/ai `@sigx/ai-actors` beside the DO-backed stores, and `@sigx/ai-agent-node` beside `EventLogStore` | after v1 stabilises (#397) |
| A re-opened session's initial head (`LiveSession.base` + `headOf` in `apps/daemon/src/daemon.ts`: `serveSession` starts every session at `(0, 0)`, so the daemon keeps `(epoch, 0)` of the resumed runtime's epoch — the ref's `data.epoch`, else the log head's + 1 — and reads the later of it and the served head) | signalxjs/ai `@sigx/ai-agent/wire` as a `serveSession({ head })` option (or a head taken from the session's own epoch); upstream issue to file | once the seam exists, the daemon drops `base` (#363) |
| Cached remote JSON behind a global actor (`packages/platform/src/releases/directory.ts`: a bounded fetch — timeout, byte cap, validation — refreshed by a reminder, read by other actors without fetching in their turn, the last good copy kept with the error beside it) | `@sigx/actors` recipes | once a second remote document is cached this way (#365) |
| Verified package install (`apps/daemon/src/harness.ts`: download streamed through a sha256, a zip unpacked one entry at a time with escaping entries refused, `treeHashOf` — the digest of `<path>\0<file sha256>\n` in path order that `scripts/lib/harness.mjs` `treeHash` writes at build time — checked against the package's manifest, then an atomic `current.json` switch beside the old version) | `@sigx/ai-agent-node` beside the process helpers, as a small "install a pinned native build" utility | when a second tool installs native builds this way (#369) |
| Conversation titles (`generateChatTitle` / `cleanTitle` in `packages/runtimes/src/anthropic/title.ts`: one `generateText` over a labelled transcript, the answer cleaned into a list title; `readSessionTitle` in `packages/runtimes/src/claude-code/title.ts`: Claude Code's own title read from the tail of its transcript under a given config dir, since the SDK's `getSessionInfo` reads the calling process's `CLAUDE_CONFIG_DIR`) | `@sigx/ai-agent` as a `SessionSummary.title` helper, and `@sigx/ai-agent-claude-code` beside `listSessions` (with a `configDir` option) | once a second consumer titles conversations (#460) |
| Model-scoped quota windows (`windowMatchesModel` + `memberWindows` in `packages/core/src/quota.ts`: a provider scopes a limit by display name, a session names its model by id or alias — match the family word, keep the shared windows plus the model's own, never another model's) | `@sigx/ai-agent` beside a future usage-limits contract | once a second runtime reports model-scoped limits (#450) |
| Process-tree telemetry (`createTelemetrySampler` in `apps/daemon/src/telemetry.ts`: one `ps` / CIM read per tick, each root's subtree by parent links charged to it, CPU as cumulative time between two samples over wall time and cores with a reused pid measuring nothing, `vm_stat` for macOS memory; `sessionPids` in `packages/runtimes/src/claude-code/pids.ts`: an `AsyncLocalStorage` around `prompt` so an agent-level `spawn` knows which session's process it starts) | `@sigx/ai-agent-node` beside `spawnAgentProcess` / `registeredChildren` | once a second host samples its runtimes (#400) |
| Slow-turn log over `host.observeTurns` (`apps/web/src/actors/slow-turns.ts`: one warning line per turn past a threshold — type, key, method, queue wait, run time, threw — attached once per host) | `@sigx/actors` as a host plugin beside `metrics()` | once a second host wants it in its logs (#492) |
| Model display names (`modelDisplayName` in `packages/ui/src/kit/model-name.ts`: `claude-opus-5-5` → `Opus 5.5`, `[1m]` → `(1M context)`, an alias's version read from the account's description, the default named by the model it runs) | `@sigx/ai-anthropic` beside the model ids | once a second app names Claude models to people (#517) |
| conduit operations as `@sigx/ai` tools — one tool per `action` / `search` operation with the spec's schema minus `x-` hints, `readOnly` / `destructive` from the spec (`destructive`, `search`, safe-method-only requests), conduit errors as tool errors with `needsReauth` said plainly (`packages/connectors/src/tools.ts`) | `@aigntiq/conduit` as an `/ai` adapter (or signalxjs/ai `@sigx/ai` beside `defineTool`) | once a second app turns conduit connectors into agent tools (#531) |
| A poll trigger over a search operation — an `after:` window overlapping the last poll, a bounded delivered-id set, oldest first with a per-poll cap that keeps its window, the cursor handed back for the host to persist (`packages/connectors/src/triggers/gmail.ts`) | `@aigntiq/conduit` as its poll-trigger runtime (`pollTrigger` specs are "delivered, not executed" in 0.1), with a Gmail `history.list` operation in `@aigntiq/conduit-connectors` | when conduit runs poll triggers itself (#535) |
| Multi-tenant conduit sign-in routes — owner-only `start` / `callback` / `disconnect` over an engine built per request from the tenant's own stores, OAuth client and a random per-tenant `secret` generated on first use; the unverified `returnTo` read off conduit's state only to route a failure, the verified one to redirect (`apps/web/src/connectors/routes.ts`, `engine.ts`) | `@aigntiq/conduit/server` as a per-tenant option of `createFetchHandler` | once a second app hosts conduit sign-in for many tenants (#533) |
| A pluggable read-only code surface — a `CodeRenderer { Viewer, Diff }` seam chosen by `useCodeRenderer` / `CodeRendererProvider`, a Monaco renderer that draws the plain grid until Monaco is ready and swaps in, and a Myers line diff with unified / split rows, hunk headers and `hunkAt` (`packages/ui/src/code`) | `@sigx/monaco-editor` (the swap-in surface, the token-built theme hook) and `@sigx/zero` (the plain grid as a code-view part) | once a second app shows files or diffs (#563) |
| An in-memory `WorkspaceSource` over a folder model — each file's text at `base` / `head` / working, the `ChangeSet`, `+/-` counts and tree change marks computed from them, answering like a daemon (`not-found`, `not-a-repo`, metadata for binaries) (`memoryWorkspaceSource` in `apps/web/src/mock/files.ts`) | `@agentic/core` testing helpers, or `@agentic/daemon-protocol/testing` beside `answerFilesOp` | once a second consumer needs a fake session folder with real diffs (#564) |
| A per-runtime registry of the files a tool call wrote — `registerFileTouches(runtime, extractor)` / `filesTouched(runtime, call)`, Claude Code's editing tools built in (`packages/runtimes/src/touches.ts`) | `@sigx/ai-agent/coding` beside `categoryOf` / `pathsOf`, keyed by harness | once a second app links tool calls to the files they changed (#565) |
| A composer `insert` prop — a host puts text into a draft it does not own, once per id, spaced, caret after it (`packages/ui/src/composer/Composer.tsx`) | `@sigx/zero` Textarea / a composer part | once zero ships a composer (#565) |
| `FormDialog` — a plain modal `Dialog` around a real `<form>` (Enter submits, `required` validates, focus on the first field), `submit` keeping it open until the caller closes, `cancel` on every non-programmatic close (`packages/ui/src/kit/FormDialog.tsx`) | `@sigx/zero-kit` as a dialog composition, or `@sigx/zero` `Dialog` docs as the form-dialog recipe | once a second app builds data-entry dialogs on zero (#586) |
| `ErrorNote` — an error line on zero `Alert` (`color="error" size="sm"`, optional title, the site's `data-*` hook forwarded) (`packages/ui/src/kit/ErrorNote.tsx`) | `@sigx/zero-kit` beside the other kit compositions | once a second app replaces hand-stamped `role="alert"` lines (#586) |
| Served-session command ordering and ghost-turn reaping: `configure` / `prompt` / `close` in order per session, and an implicit turn that stays empty cancelled after a quiet window (`apps/daemon/src/daemon.ts` `inOrder`, `watchTurns`, `reap`) | `@sigx/ai-agent/wire` `serveSession` | once signalxjs/ai#193 lands and `serveSession` orders commands itself (#604) |
| Deterministic `{token}` templates — expand, validate (unknown tokens, unbalanced braces), slug, and an absolute folder normalised per OS (`packages/plugins-git/src/templates.ts`) | `@agentic/core` beside `suggestWorktreePath`, or `@sigx/ai-agent/coding` | once a second plugin names things from project templates (#619) |
| `SchemaForm` `change` event and `load` / `value` on its API — a caller previews the live draft and lays a preset over it (`packages/ui/src/forms/schema-form.tsx`) | `@sigx/zero` form parts | once zero ships a schema-driven form (#621) |
| A disclosure that follows a default until the reader toggles it — `followDisclosure(follow)` feeding a `Collapsible.Root` `model` + `onOpenChange`, so streaming updates never re-open or fold what the reader set (`packages/ui/src/thread/disclosure.ts`) | `@sigx/zero` `Collapsible` as a `defaultOpen` that may change (a "follow until touched" mode) | once a second app folds streaming content (#590) |
| `followLink` — one click handler on a container that sends plain left clicks on in-app `<a href>` descendants (rows that are whole links, menu items) through the router, leaving modified clicks, `target` and external links to the browser (`apps/web/src/pages/plugins/PluginsList.tsx`) | `@sigx/router` as a delegated link helper | once a second page renders plain anchors it wants routed (#637) |
| A host allowlist on a connector's `fetch` from its granted `network:` scopes — refused before sending, a scope-only error, a `ConduitError` so conduit neither retries nor wraps it (`guardHttp` in `packages/connectors/src/network.ts`, `guardFetch` in `packages/mcp/src/client/network.ts`) | `@aigntiq/conduit` as a per-engine `allowedHosts` that narrows rather than widens, and `@sigx/ai-agent` MCP client options | once a second host fences connector egress by grant (#642) |
| `FilterChips` — a filter bar as one control on zero `ToggleGroup` (single value, not deselectable, optional per-chip count, `name` posts it), its chip look in the design system's toggle-group patch keyed on `data-filter-chips` (`packages/ui/src/kit/FilterChips.tsx`) | `@sigx/zero-kit` beside the other kit compositions, or a `chips` variant of zero-daisyui's toggle-group | once a second app draws filter bars on zero (#591) |
| A `var()` fallback transform at a fragment boundary — `withFallbacks(value, table)` rewrites every bare `var(--x)` named in a table to `var(--x, <fallback>)` in any string at any depth (recipes, raw CSS), leaving existing fallbacks and keys alone, so a pack passes `zero:fragment`'s lynx probe without hand-editing its recipes (`packages/ui/src/fragment/fallbacks.ts`) | `@sigx/zero-kit` | if a second pack needs it; moot for the kit vocabulary once the probe defines it (signalxjs/zero#158) |
| A zero part rendered `asChild` as a routed link — `Card.Root asChild` over a real `<a href>` whose plain left click goes through the router (`AgentCardLink` in `apps/web/src/pages/agent/AgentCardLink.tsx`), because the router's `Link` forwards no `data-*` and so cannot wear a part's anatomy | `@sigx/router` (`Link` forwarding attributes, or an `asChild` mode) | once a second page renders a zero part as a router link (#592) |
| Dropping a pack's breakpoint-keyed `at` entries before publishing: `withoutBreakpoints(recipes)` walks every `at`, `composes` included, and keeps raw `@` preludes and built-ins (`packages/ui/src/_zero-gaps/pack-breakpoints.ts`) | the `sigx zero:fragment` probe's fit (declare `breakpoints: {}`) | delete once signalxjs/zero#225 ships (#595) |
| Recovering tool parameters a model wrote into a string argument as its own call markup (`…</text>\n<parameter name="mentions">[…]`), only when the tail is nothing but known array parameters holding JSON (`recoverLeakedParameters` in `packages/runtimes/src/tools/chat.ts`) | `@sigx/ai` `defineTool` (an opt-in input repair before validation) | once a second tool loses a parameter this way (#599) |
| `liveOverSockets` — `live()` subscriptions routed to one `socketTransport` per actor on the object-terminated `/_sigx/socket/{type}/{key}` upgrade, ref-counted and closed with the last subscriber; calls stay on `fetchTransport` (`apps/web/src/actors/live-socket.ts`) | `@sigx/actors-ws/client` (signalxjs/actors#490) | delete once signalxjs/actors#490 ships (#712) |

## Projects redesign

One slot per sub-issue of [#722](https://github.com/andtii/agentic/issues/722). Each issue replaces its own line with what it wrote that is generic (piece, where it lands, when), or leaves the dash.

- #723: —

- #724: —

- #725: `NavItem.children` (a nav entry's sub-menu in blocks, the page on the longest matching sub-item) in `@agentic/ui`'s `AppShell` — a zero `NavList` candidate for nested items once #727 settles the visuals.

- #726: `StageTrack` (a segmented progress track, current segment in a state colour) and `ChecksBar` (a proportional multi-state bar with a worded summary) in `@agentic/ui` `projects/` — zero `Progress`/`Meter` variant candidates; the parts style inline because zero parts forward no `style` and the package ships no per-part stylesheet export.

- #727: the nested nav look (indented sub-menu behind a rule, compact 32 px sub-items, a plain count beside the badge, a labelled or divided block, a switcher button heading the sub-menu) in `@agentic/ui`'s `shell.css` / `AppShell` — a zero `NavList` candidate with #725's `NavItem.children`.

- #728: `pickerMove` (`apps/web/src/pages/projects/layout/ProjectPicker.tsx`) — wrapping ArrowUp/Down/Home/End over a combobox's options; a candidate for a zero `Combobox`/listbox keyboard helper.

- #729: `pages/projects/index/model.ts` pill / strip wording (`cardPills`, `unassignedText`) could move to `@agentic/ui` once Home or project Overview needs the same `N YOUR MOVE` / `N AGENTS ON IT` pills.

- #730: nothing generic — the Overview's row and card styles stay in `apps/web/src/styles/projects/overview.css`.

- #731: `pages/projects/chats/groups.ts` `suggestedProject` (a chat names a project as a word) and `listOf` (`a, b and c`) are generic; `ProjectChatWatch` repeats `/chats`' renderless `ChatWatch` (`pages/chat/LiveChats.tsx`, not exported) — export it from there if a third page needs one.

- #732: `groupChatsByProject` (`apps/web/src/pages/chat/chat-groups.ts`) — a generic group-by-key-ordered-by-recency; stays in web until a second list needs it.

- #733: `apps/web/src/pages/projects/settings/general/TabFrame.tsx` — a settings section with its own Save, inline refusal and a "Saved" that clears when the form moves on; a candidate for `@agentic/ui` once another settings page wants it.

- #734: `eachLimited` (bounded-concurrency fan-out) in `packages/platform/src/workspace/index.ts` is generic: a candidate for `@sigx/actors` next to hop fan-out helpers.

- #735: —

- #736: `unmetNeeds` / `catalogueTiles` in `apps/web/src/pages/projects/settings/features/model.ts` are generic over `ProjectFeatureView` and could move to `@agentic/core` beside `ProjectFeatureUi` once a second surface (the New project dialog) needs them.

- #737: `featureTools` / `withFeatureTools` (`packages/platform/src/routing/features.ts`) — a named tool-family registry joined to an agent's grants under its policy; generic enough for `@sigx/ai-agent` tool sets.

- #738: `workItemsOf` (`apps/web/src/pages/projects/work/model.ts`) — pure derivation of work items from tasks, PRs and plan items; a candidate for `@agentic/core` next to `workStagesFor` once a second surface (Home, MCP) needs it.

- #739: `stepsOf` (`apps/web/src/pages/projects/work/item/model.ts`) — a labelled stage stepper beside `StageTrack`; move it into `@agentic/ui` when a second page needs named stages.

- #740: —

- #741: `pullRepoOfOrigin` (origin URL → host + `owner/name`) and the GitHub rate-limit window handling in `plugins-git/src/provider/` are generic git-host helpers; candidates for a shared forge-client package once a second consumer appears.

- #742: `tokenPullSources` (packages/platform/src/pulls/ports.ts) — a per-credential adapter cache with a TTL; generic enough for any polled provider that opens a secret per call.

- #743: `stepAutopilot` (packages/platform/src/pulls/autopilot.ts) — a pure observe → actions state machine with an attempt limit and settle/stale turn windows; the shape fits any agent that babysits an external resource.

- #744: `pullSteps` / `blockerSentence` / `pullNow` (`apps/web/src/pages/projects/work/pull/model.ts`) — the PR stepper, merge sentence and now-line; move to `@agentic/ui` beside `PullCard` when chat, Home and notifications show the same states.

- #745: `pullNextMove` / `pullNeedsYou` / `pullStatusText` (`packages/ui/src/projects/PullCard.tsx`) are provider-neutral PR state rules — candidates for `@agentic/core` next to `pullBlockers`.

- #746: nothing generic — the Code card and section derive from `workItemsOf` (Work) and style in `apps/web/src/styles/projects/git.css`.

- #747: `pullMove` / `pullNotification` (`packages/platform/src/pulls/notify.ts`) — a provider-neutral "whose move is this PR" rule; candidate for `@agentic/core` next to `pullBlockers` once the UI's owner badge needs it.

- #748: `parseRefs`/`formatRef` in `packages/core/src/refs.ts` — a generic typed-ref tokenizer (items, mentions, file ranges, commits, URLs); a candidate for a sigx text utility once a second consumer appears.

- #749: — (scaffold only; nothing generic)

- #750: `packages/platform/src/plan/rules.ts` — ordered per-assignee queues with leased claims (renew on any call, expiry back to the queue top, alarm-armed) are a generic work-queue primitive; a candidate for `@sigx/actors` once a second store needs it.

- #751: `planNext` / `planClaimRefusal` / `planTouchWarnings` in `packages/runtimes/src/tools/plan.ts` are pure plan rules over core types; if the Plan actor (#750) or the web needs the same next-item pick, promote them to `packages/core/src/plan.ts`.

- #752: — (daemon-only git read; nothing generic)

- #753: — (plan feature manifest, presets and instructions; nothing generic)

- #754: `useFollow` in `apps/web/src/pages/projects/features/plan/shared/parts.tsx` — a router-followed plain `<a>`, because `@sigx/router`'s `Link` forwards no attributes and sets `aria-current` by path only (ignores the query); candidate for a `Link` fix upstream in `@sigx/router`.

- #755: `apps/web/src/pages/projects/features/plan/board/model.ts` keyboard drag slot stepping (`stepSlot`) — a generic sortable-lists keyboard pattern that could become a zero part.

- #756: `planGraphLayout` (apps/web plan/graph/layout.ts) — a layered DAG layout by dependency depth in lanes; generic enough for a `@agentic/ui` graph part once a second view needs it.

- #757: none — requests, PM policy and personality presets are agentic product contracts.

- #784: none — the project manager playbook, name suggestions and config builder are agentic product behaviour.

- #758: —

- #759: `requestResolveRefusal` / `requestWhyLine` in `packages/runtimes/src/tools/requests.ts` are pure request rules over core types; if the Requests actor (#758) or the inbox (#761) needs the same decision or "why you:" text, promote them to `packages/core/src/requests.ts`.

- #760: —

- #761: none — the Requests inbox is agentic product UI.

- #762: —

- #763: —

- #764: `projectHandle` / `resolveProject` (project name → handle for `project#n`) and the upstream-first `order` in `packages/platform/src/plan/links.ts` are generic — candidates for core next to `refs.ts`.

- #765: the lane layout (`pages/projects/links/model.ts`) may merge with the Plan graph layout (`features/plan/graph/layout.ts`) once #764 gives both one item shape — a candidate for one lanes-and-arrows graph helper.

- #766: —

- #767: —
