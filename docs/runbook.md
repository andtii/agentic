# Runbook — Cloudflare deploy

The web app and every platform actor run as one Cloudflare Worker (`apps/web`) plus one Durable Object class, `ActorHost` (architecture §3). This page covers local runs, secrets, the preview deploy and production.

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

Generate a value with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Rotating `SESSION_SECRET` signs everyone out and invalidates agent tokens; rotating `WORKSPACE_KEK` makes stored API keys unreadable, so they must be re-entered.

## Preview deploy

The `preview` environment in `wrangler.jsonc` deploys a separate worker, `agentic-web-preview`, with its own Durable Objects and R2 bucket, so preview data never touches production.

One-time setup:

```sh
cd apps/web
pnpm exec wrangler r2 bucket create agentic-artifacts-preview
pnpm exec wrangler secret put SESSION_SECRET --env preview
pnpm exec wrangler secret put GITHUB_CLIENT_ID --env preview
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env preview
pnpm exec wrangler secret put WORKSPACE_KEK --env preview
```

Set `env.preview.vars.APP_ORIGIN` in `wrangler.jsonc` to the URL wrangler prints on the first deploy (`https://agentic-web-preview.<account>.workers.dev`), and register `${APP_ORIGIN}/auth/callback` on a GitHub OAuth app used only for preview.

Deploy:

```sh
pnpm build
pnpm --filter @agentic/web deploy:preview    # build + wrangler deploy --env preview
```

Smoke check: `GET /` returns the SSR shell (200); `GET /auth/me` returns 401 before sign-in; `/_agentic/daemon/<id>` returns 501 until the Machine actor lands (#36).

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
| Session `factory` for `anthropic-api` | returns `null` (daemon path) | #35 |
| Daemon socket + command sink (Machine actor) | 501 / commands refused | #36 |
| Schedule trigger's `EnvironmentProbe` (is an environment online?) | every environment is offline: a scheduled task that needs one waits `environment-offline` for the router | #37 |
| Web Push channel (VAPID keys) | no channels | — |
