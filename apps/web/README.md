# @agentic/web

The web app: a server-rendered SignalX app (streaming SSR + hydration, `@sigx/router`, server functions) deployed as a Cloudflare Worker, with the UI on `@sigx/zero` skinned by `@agentic/ui`'s `control-room` design system (zero-daisyui derived; `docs/design/HANDOFF.md`) and the responsive shell from `@agentic/ui`.

Scaffolded with `sigx create web --kind ssr --target cloudflare --features router,server-fn --styling none`; the Cloudflare entry (`src/entry.cloudflare.ts`, `wrangler.jsonc`) is extended by the worker-entry issue.

## Scripts

```sh
pnpm --filter @agentic/ui build        # once: the app consumes @agentic/ui through its package exports
pnpm --filter @agentic/web dev         # Vite dev server on http://localhost:3000
pnpm --filter @agentic/web build       # zero:validate, then dist/server + dist/client
pnpm --filter @agentic/web preview     # wrangler dev over the production build
pnpm --filter @agentic/web test:workers    # the Worker + ActorHost Durable Object inside workerd (Node >= 22)
pnpm --filter @agentic/web test:acceptance # requirements §17 as scripted scenarios, workerd + in-process (docs/acceptance.md)
pnpm --filter @agentic/web deploy:preview  # build + wrangler deploy --env preview (docs/runbook.md)
pnpm --filter @agentic/web zero:validate   # the design system against zero's anatomy manifest (also part of build)
pnpm --filter @agentic/web test:e2e    # Playwright smoke at 400px and 1280px (see below)
```

## Layout

- `src/App.tsx` — the root: `ThemeProvider` + `AppShell` (from `@agentic/ui`) around `RouterView`; `themeInitScript` goes into `<head>` through `useHead`.
- `src/router.ts` — the route table (docs/architecture.md §10): `/`, `/chats`, `/chats/:id`, `/agents`, `/agents/:id`, `/tasks/:id`, `/sessions/:id`, `/machines`, `/machines/:id`, `/schedules`, `/plugins`, `/settings`, `/pair`, `/history`, `/usage` (`/chats`, `/history`, `/usage` are placeholders until #88 / #90).
- `src/pages/` — one component per route. Agents, Chats, Sessions, the Task page, Tasks, Home, History, Usage, Schedules, Plugins and Settings read the platform in `live` mode (`src/data-mode.ts`: `VITE_AGENTIC_DATA=mock|live`, default `live` in a production build, `mock` under the dev server and vitest — the Playwright specs drive the mock workspace); every other page reads `src/mock/*` until its lane lands. `src/actors/` holds the browser's actor stubs and the `useActorDefs` / `useViewer` injectables both entries provide.
- `src/nav.ts` — the sidebar groups (Primary / Workspace), the Home badge count and the breadcrumb roots.
- `src/styles.css` (document surface) and `src/styles/pages.css` (per-screen grids, one section per page).
- `src/entry-client.tsx` / `src/entry-server.tsx` — import `@agentic/ui/css` (after `@sigx/zero/css`), call `installThemes()` from `@agentic/ui/design-system`, build the app.
- `src/api/*.server.ts` — server functions (only ever run on the server).
- `src/entry.cloudflare.ts` — the Worker: daemon socket stub → auth routes → the A2A mount → actor mount + sockets → server functions → document render; exports `ActorHost`.
- `src/a2a/` — the A2A server as a plugin (#245): `mount.ts` answers `/.well-known/agent-card.json` and `/_agentic/a2a/*` for a workspace whose `agentic.a2a.server` plugin is on (404 otherwise; bearer = an OAuth access token with `tasks` + `sessions`); `session.ts` turns each A2A task into a platform task.
- `src/connectors/` — connecting conduit connectors (#533): `routes.ts` answers `GET /_agentic/connectors/:id/start`, `GET /_agentic/connectors/callback` and `POST /_agentic/connectors/:id/disconnect` for the signed-in owner; `engine.ts` builds the workspace's conduit engine (its `ConnectorAccounts`, the plugin's OAuth client, the generated `connector-engine-secret`); `opener.ts` opens a connected account as session tools. The Gmail page is `/plugins/gmail`; setup in `docs/runbook.md` "Connect Gmail".
- `src/actors.app.ts` — the platform actor registry, the `ActorHost` Durable Object class, the Worker half, and the ports later issues fill (`defaultPorts`).
- `__tests__/workers/` — workerd tests over the HTTP actor mount (workspace + agent + chat, eviction, 401/403, `memoryConformance` on Durable Object storage); own `tsconfig.json`, excluded from the root typecheck and `pnpm test`.
- `__tests__/acceptance/` — the acceptance suite (`docs/acceptance.md`): one file per §17 scenario; `*.workers.test.ts` run in workerd (`vitest.acceptance.config.ts`, own `tsconfig.json`), the rest in process on the app's own registry (`host.ts`) or the live page harness.

## Theme

One theme, `control-room`, dark only (docs/decisions.md), set on `<html data-theme>` in `index.html` and `color-scheme: dark` in `styles.css`. The init script in `<head>` still restores a persisted `zero-theme` choice, and `App.tsx` links the Google Fonts stylesheet (Schibsted Grotesk, JetBrains Mono). `zero:validate` checks `@agentic/ui`'s compiled design system with the `ai-*` fragment merged; the coverage report prints the warning count (declared-but-unwired axes until #85 / #87).

## Playwright

Three projects, one per width the handoff distinguishes (`docs/design/HANDOFF.md` → "Responsive behaviour"); each spec picks its regime with `test.skip` on the viewport:

| Project | Viewport | Specs |
|---|---|---|
| `phone-400` | 400 × 800 | `mobile.spec.ts` (no horizontal scroll on the fourteen routes, the 312 px drawer with 50 px items and focus return, back link + title + sub-line on detail routes, the docked composer with 48 px controls, the approval card's full-row `Allow once`, stacked tables, 52 px environment rows, touch targets), the phone half of `shell.spec.ts` |
| `tablet-1024` | 1024 × 800 | `tablet.spec.ts` (rails drop under the main column in the handoff order, Chat keeps list + thread with the context panel behind the tasks button, three-column grids become two, no horizontal scroll), plus the desktop specs that do not skip below 1280 |
| `desktop-1280` | 1280 × 800 | `shell.spec.ts`, `core.spec.ts`, `agents.spec.ts`, `ops.spec.ts` |

It runs against the dev server, so build `@agentic/ui` first and install a browser once:

```sh
pnpm --filter @agentic/ui build
pnpm --filter @agentic/web exec playwright install chromium
pnpm --filter @agentic/web test:e2e        # every project
pnpm --filter @agentic/web e2e:mobile      # the phone only
```

CI runs the whole suite in the `e2e` job (`.github/workflows/ci.yml`, ubuntu, Chromium with system deps) after `pnpm build`; a failed run uploads `playwright-report`.

`e2e/demo1.spec.ts` is not part of it: it is the demo 1 walk-through (#35) against a DEPLOYED Worker — `BASE_URL=… AGENTIC_DEV_LOGIN=… pnpm --filter @agentic/web smoke:demo1` (`playwright.demo1.config.ts`, video always on). See `docs/runbook.md` → "Demo 1 smoke".

## Deploy (Cloudflare Workers)

```sh
pnpm --filter @agentic/web build
pnpm --filter @agentic/web preview   # wrangler dev
pnpm --filter @agentic/web deploy    # wrangler deploy (run `pnpm exec wrangler login` once)
```

Secrets (`SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `WORKSPACE_KEK`), the R2 bucket, the preview environment and the Durable Object migration rules are in [`docs/runbook.md`](../../docs/runbook.md). Without `SESSION_SECRET` the worker still serves pages, but every actor call is anonymous and refused.
