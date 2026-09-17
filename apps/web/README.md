# @agentic/web

The web app: a server-rendered SignalX app (streaming SSR + hydration, `@sigx/router`, server functions) deployed as a Cloudflare Worker, with the UI on `@sigx/zero` + `@sigx/zero-daisyui` and the responsive shell from `@agentic/ui`.

Scaffolded with `sigx create web --kind ssr --target cloudflare --features router,server-fn --styling none`; the Cloudflare entry (`src/entry.cloudflare.ts`, `wrangler.jsonc`) is extended by the worker-entry issue.

## Scripts

```sh
pnpm --filter @agentic/ui build        # once: the app consumes @agentic/ui through its package exports
pnpm --filter @agentic/web dev         # Vite dev server on http://localhost:3000
pnpm --filter @agentic/web build       # zero:validate, then dist/server + dist/client
pnpm --filter @agentic/web preview     # wrangler dev over the production build
pnpm --filter @agentic/web zero:validate   # the design system against zero's anatomy manifest (also part of build)
pnpm --filter @agentic/web test:e2e    # Playwright smoke at 400px and 1280px (see below)
```

## Layout

- `src/App.tsx` — the root: `ThemeProvider` + `AppShell` (from `@agentic/ui`) around `RouterView`; `themeInitScript` goes into `<head>` through `useHead`.
- `src/router.ts` — the route table (docs/architecture.md §10): `/`, `/chats/:id`, `/agents`, `/agents/:id`, `/tasks/:id`, `/sessions/:id`, `/machines`, `/machines/:id`, `/schedules`, `/plugins`, `/settings`, `/pair`.
- `src/pages/` — one component per route, mock data only (`src/mock/data.ts`).
- `src/nav.ts` — the primary navigation.
- `src/entry-client.tsx` / `src/entry-server.tsx` — import the design system CSS, call `installThemes()`, build the app.
- `src/api/*.server.ts` — server functions (only ever run on the server).

## Theme

`@sigx/zero-daisyui` ships `light`/`dark` (+ `dim`, `nord`, `sunset`). System light/dark is pure CSS (`light-dark()`); an explicit choice is stored under `zero-theme` and restored before first paint by the init script in `<head>`.

## Playwright

`e2e/shell.spec.ts` renders the shell at 400px (drawer navigation) and 1280px (sidebar navigation) and navigates two routes each. It runs against the dev server; install a browser once:

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
