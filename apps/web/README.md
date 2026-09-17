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
pnpm --filter @agentic/web deploy:preview  # build + wrangler deploy --env preview (docs/runbook.md)
pnpm --filter @agentic/web zero:validate   # the design system against zero's anatomy manifest (also part of build)
pnpm --filter @agentic/web test:e2e    # Playwright smoke at 400px and 1280px (see below)
```

## Layout

- `src/App.tsx` — the root: `ThemeProvider` + `AppShell` (from `@agentic/ui`) around `RouterView`; `themeInitScript` goes into `<head>` through `useHead`.
- `src/router.ts` — the route table (docs/architecture.md §10): `/`, `/chats`, `/chats/:id`, `/agents`, `/agents/:id`, `/tasks/:id`, `/sessions/:id`, `/machines`, `/machines/:id`, `/schedules`, `/plugins`, `/settings`, `/pair`, `/history`, `/usage` (`/chats`, `/history`, `/usage` are placeholders until #88 / #90).
- `src/pages/` — one component per route, mock data only (`src/mock/data.ts`).
- `src/nav.ts` — the sidebar groups (Primary / Workspace), the Home badge count and the breadcrumb roots.
- `src/styles.css` (document surface) and `src/styles/pages.css` (per-screen grids, one section per page).
- `src/entry-client.tsx` / `src/entry-server.tsx` — import `@agentic/ui/css` (after `@sigx/zero/css`), call `installThemes()` from `@agentic/ui/design-system`, build the app.
- `src/api/*.server.ts` — server functions (only ever run on the server).
- `src/entry.cloudflare.ts` — the Worker: daemon socket stub → auth routes → actor mount + sockets → server functions → document render; exports `ActorHost`.
- `src/actors.app.ts` — the platform actor registry, the `ActorHost` Durable Object class, the Worker half, and the ports later issues fill (`defaultPorts`).
- `__tests__/workers/` — workerd tests over the HTTP actor mount (workspace + agent + chat, eviction, 401/403, `memoryConformance` on Durable Object storage); own `tsconfig.json`, excluded from the root typecheck and `pnpm test`.

## Theme

One theme, `control-room`, dark only (docs/decisions.md), set on `<html data-theme>` in `index.html` and `color-scheme: dark` in `styles.css`. The init script in `<head>` still restores a persisted `zero-theme` choice, and `App.tsx` links the Google Fonts stylesheet (Schibsted Grotesk, JetBrains Mono). `zero:validate` checks `@agentic/ui`'s compiled design system with the `ai-*` fragment merged; the coverage report prints the warning count (declared-but-unwired axes until #85 / #87).

## Playwright

`e2e/shell.spec.ts` renders the shell at 400px (drawer navigation) and 1280px (232 px sidebar, 60 px topbar, nav groups, badge, breadcrumb) and navigates two routes each, plus the nav placeholders. It runs against the dev server; install a browser once:

```sh
pnpm --filter @agentic/ui build
pnpm --filter @agentic/web exec playwright install chromium
pnpm --filter @agentic/web test:e2e
```

CI does not run it yet (no browser install step); `pnpm test` covers the route table and the shell/layout units.

## Deploy (Cloudflare Workers)

```sh
pnpm --filter @agentic/web build
pnpm --filter @agentic/web preview   # wrangler dev
pnpm --filter @agentic/web deploy    # wrangler deploy (run `pnpm exec wrangler login` once)
```

Secrets (`SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `WORKSPACE_KEK`), the R2 bucket, the preview environment and the Durable Object migration rules are in [`docs/runbook.md`](../../docs/runbook.md). Without `SESSION_SECRET` the worker still serves pages, but every actor call is anonymous and refused.
