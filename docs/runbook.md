# Runbook — Cloudflare deploy

The web app and every platform actor run as one Cloudflare Worker (`apps/web`) plus one Durable Object class, `ActorHost` (architecture §3). This page covers local runs, secrets, the preview deploy and production.

`wrangler.jsonc`'s `main` is `apps/web/worker.mjs`, a one-line façade that re-exports `default` and `ActorHost` from the built `dist/server/entry.cloudflare.js`: the app build's entry chunk also re-exports helpers its sibling chunks share, and workerd refuses a module Worker whose exports are not handlers or classes ("Incorrect type for map entry 'n'"), so the raw entry never starts. Keep `main` on the façade.

## Prerequisites

- Node ≥ 22.12, pnpm, a Cloudflare account with Workers Paid (Durable Objects on SQLite).
- `pnpm install` at the repo root, then `pnpm exec wrangler login` once (from `apps/web`).

## Local

```sh
pnpm build                                   # packages first; the app consumes them through package exports
pnpm --filter @agentic/web preview           # wrangler dev over dist/, Durable Objects + R2 simulated locally
pnpm --filter @agentic/web test:workers      # the Worker + ActorHost inside workerd
```

Local secrets go in `apps/web/.dev.vars` (never committed):

```ini
SESSION_SECRET=<at least 32 random characters>
GITHUB_CLIENT_ID=<OAuth app client id>
GITHUB_CLIENT_SECRET=<OAuth app client secret>
WORKSPACE_KEK=<base64 of 32 random bytes>
ANTHROPIC_API_KEY=<the key the anthropic-api runtime uses>
AGENTIC_DEV_LOGIN=<optional, ≥ 16 chars: enables POST /auth/dev-login for scripted walk-throughs>
```

Without `SESSION_SECRET` the worker serves pages but refuses every actor call as anonymous (it logs a warning). The auth routes (`/auth/*`) are mounted only when `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `APP_ORIGIN` are all set.

## Secrets and bindings

| Name | Kind | What |
|---|---|---|
| `ACTORS` | Durable Object binding | `ActorHost`, one object per actor |
| `ARTIFACTS` | R2 bucket | artifacts and exports (`agentic-artifacts`, `agentic-artifacts-preview`) |
| `APP_ORIGIN` | var | public origin; the OAuth callback is `${APP_ORIGIN}/auth/callback` |
| `SESSION_SECRET` | secret | ≥ 32 chars; signs `__Host-session`, OAuth transients and agent tokens |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | secret | the GitHub OAuth app |
| `WORKSPACE_KEK` | secret | base64, 32 bytes; AES-GCM key for stored API keys (Registry secrets; absent → `setSecret` refuses `no-kek`) |
| `ANTHROPIC_API_KEY` | secret | the key every `anthropic-api` session of this deployment runs with (`createSessionFactory`, architecture §5a); absent → an API-runtime task fails `no-api-key`. Per-workspace BYO keys through the Registry are a follow-up |
| `AGENTIC_DEV_LOGIN` | secret, **preview only** | ≥ 16 chars; while set, `POST /auth/dev-login` `{ token, user }` mints a `dev_<user>` session for a caller presenting it (`smoke:demo1`). Unset → the route does not exist. Never set it on production |

Generate a value with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Rotating `SESSION_SECRET` signs everyone out and invalidates agent tokens; rotating `WORKSPACE_KEK` makes stored API keys unreadable, so they must be re-entered.

## Preview deploy

The `preview` environment in `wrangler.jsonc` deploys a separate worker, `agentic-web-preview`, with its own Durable Objects and R2 bucket, so preview data never touches production.

One-time setup (each `secret put` prompts for the value on stdin):

```sh
cd apps/web
pnpm exec wrangler login                                        # once per machine
pnpm exec wrangler r2 bucket create agentic-artifacts-preview   # the ARTIFACTS binding of env.preview
pnpm exec wrangler secret put SESSION_SECRET --env preview        # ≥ 32 random chars
pnpm exec wrangler secret put WORKSPACE_KEK --env preview         # base64 of 32 random bytes
pnpm exec wrangler secret put GITHUB_CLIENT_ID --env preview      # the preview GitHub OAuth app
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env preview
pnpm exec wrangler secret put ANTHROPIC_API_KEY --env preview     # the anthropic-api runtime's key
pnpm exec wrangler secret put AGENTIC_DEV_LOGIN --env preview     # ≥ 16 random chars; preview only — enables /auth/dev-login
```

Set `env.preview.vars.APP_ORIGIN` in `wrangler.jsonc` to the URL wrangler prints on the first deploy (`https://agentic-web-preview.<account>.workers.dev`), and register `${APP_ORIGIN}/auth/callback` on a GitHub OAuth app used only for preview. The Durable Object migration (`v1`, `new_sqlite_classes: ["ActorHost"]`) is in `wrangler.jsonc` and applies itself on the first deploy — nothing to run by hand.

Deploy:

```sh
pnpm build
pnpm --filter @agentic/web deploy:preview            # build + wrangler deploy --env preview
pnpm --filter @agentic/web deploy:preview:dry-run    # the same bundle, offline: bindings and size, no upload
```

Smoke check: `GET /` returns the SSR shell (200); `GET /auth/me` returns 401 before sign-in; `POST /auth/dev-login` with the wrong token returns 403 (404 when the secret is unset).

### Demo 1 smoke (`smoke:demo1`, issue #35)

The scripted walk-through of demo 1 — sign in, create an agent on the `anthropic-api` runtime, open a direct chat, post, watch the answer stream — as a Playwright spec (`apps/web/e2e/demo1.spec.ts`, config `playwright.demo1.config.ts`) against a deployed Worker. It signs in through the preview-only dev login, so the Worker needs `AGENTIC_DEV_LOGIN` and `ANTHROPIC_API_KEY` set as above.

```sh
pnpm --filter @agentic/web exec playwright install chromium      # once
BASE_URL=https://agentic-web-preview.<account>.workers.dev AGENTIC_DEV_LOGIN=<the same value as the preview secret> pnpm --filter @agentic/web smoke:demo1
```

On Windows PowerShell: `$env:BASE_URL='https://…'; $env:AGENTIC_DEV_LOGIN='…'; pnpm --filter @agentic/web smoke:demo1`.

The same smoke runs against a local `wrangler dev` (`pnpm --filter @agentic/web preview` after `pnpm build`, with `ANTHROPIC_API_KEY` and `AGENTIC_DEV_LOGIN` in `apps/web/.dev.vars`) as `BASE_URL=http://localhost:8787`. Without the key every step up to the post passes and the last assertion names the missing key — the task fails `session-open` (`no-api-key`) on the platform; the chat shows no row for that yet.

Each run signs in as a fresh `dev_demo1-<stamp>` identity (set `DEMO1_USER` to reuse one), so the roster starts empty and the recording shows the whole flow: the empty roster → "New agent" → Ada on the platform runtime → her Config tab, a saved version (v2 in the rail) → "Start chat" → the message → Ada's answer streaming in. Video is always recorded to `apps/web/test-results/demo1/**/video.webm` (the artefact the issue asks for); the HTML report lands in `apps/web/playwright-report/demo1`. The same walk-through runs offline in CI with the mock model: `apps/web/__tests__/pages/demo1-live.test.tsx` (the pages on the live harness) and `apps/web/__tests__/workers/demo1.test.ts` (dev login + the actors inside workerd).

## Production

```sh
cd apps/web
pnpm exec wrangler r2 bucket create agentic-artifacts
pnpm exec wrangler secret put SESSION_SECRET        # and the other secrets
cd ../.. && pnpm build && pnpm --filter @agentic/web deploy
```

## Durable Object migrations — read before changing `wrangler.jsonc`

- `ActorHost` is declared with `new_sqlite_classes` in migration `v1`. Never edit that entry, and never declare the class with `new_classes`: a class's storage backend cannot change after the first deploy.
- Renaming or deleting the class needs a NEW migration tag (`renamed_classes` / `deleted_classes`); deleting destroys every actor's state.
- An object's id derives from `type<NUL>key` (`durableObjectName`). Changing that derivation re-points every actor at an empty object — a data migration, not a config change.
- A deploy restarts running objects. `onDeactivate` never runs on Workers; actors persist inside each turn, so nothing saved is lost, but live runtime sessions are interrupted and resume as "interrupted" (architecture §5a).

## Rollback

```sh
cd apps/web
pnpm exec wrangler deployments list [--env preview]
pnpm exec wrangler rollback <version-id> [--env preview]
```

A rollback restores code, not Durable Object data. If the older version cannot read state a newer version wrote, roll forward instead.

## Not wired yet

| Seam | Default until then | Issue |
|---|---|---|
| Per-workspace BYO Anthropic key (Registry secret) | the deployment's `ANTHROPIC_API_KEY` serves every workspace (#35) | — |
| Daemon socket + command sink (Machine actor) | 501 / commands refused | #36 |
| Schedule trigger's `EnvironmentProbe` (is an environment online?) | every environment is offline: a scheduled task that needs one waits `environment-offline` for the router | #37 |
| Web Push channel (VAPID keys) | no channels | — |
