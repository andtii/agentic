# Runbook — deploy, daemon install, smokes, operations

Someone with a Cloudflare account, a GitHub account and a Windows machine can bring the platform up from this page (OPS-09, #52). It covers a fresh production deploy from zero, the preview environment, local runs, the daemon installer on a Windows machine, the demo 1 and demo 2 smokes, rollback and day-two operations, and — kept honest at the end — what is not wired yet.

The web app and every platform actor run as one Cloudflare Worker (`apps/web`) plus one Durable Object class, `ActorHost` (architecture §3). `wrangler.jsonc`'s `main` is `apps/web/worker.mjs`, a one-line façade that re-exports `default` and `ActorHost` from the built `dist/server/entry.cloudflare.js`: the app build's entry chunk also re-exports helpers its sibling chunks share, and workerd refuses a module Worker whose exports are not handlers or classes ("Incorrect type for map entry 'n'"), so the raw entry never starts (#129). Keep `main` on the façade.

## 1. Prerequisites

- Node ≥ 22.12 and pnpm 10 (`corepack enable`), Git.
- A Cloudflare account on **Workers Paid** (Durable Objects on SQLite storage and R2 need it). Note the account's `workers.dev` subdomain (dashboard → Workers & Pages → overview).
- A GitHub account that can create an OAuth app (personal or in an org).
- An Anthropic API key for the platform-managed `anthropic-api` runtime (console.anthropic.com → API keys). It is not a deployment secret: each workspace enters its own at `/plugins/anthropic-api` after signing in (#231).
- For the daemon: a Windows 10/11 machine with Node ≥ 22.12 and at least one Claude Code account signed in per profile directory (`docs/multi-account.md`).

Clone and install once:

```sh
git clone https://github.com/andtii/agentic && cd agentic
pnpm install
pnpm build                       # every package; the app consumes them through package exports
cd apps/web && pnpm exec wrangler login && cd ../..   # once per machine; opens the browser
```

## 2. Fresh production deploy from zero

Every step is idempotent; re-run any of them. Production is the top level of `apps/web/wrangler.jsonc` (worker `agentic-web`); preview is `env.preview` (§3).

### 2.1 Choose the origin

The Worker answers on `https://agentic-web.<subdomain>.workers.dev` by default. To use your own domain add, at the top level of `wrangler.jsonc`, `"routes": [{ "pattern": "agentic.example", "custom_domain": true }]` for a zone on this account.

Set the public origin in `wrangler.jsonc` → top-level `vars.APP_ORIGIN` (the checked-in value is `http://localhost:8787` for local runs — change it before the first deploy):

```jsonc
"vars": { "APP_ORIGIN": "https://agentic-web.<subdomain>.workers.dev" }
```

`APP_ORIGIN` is the base of the OAuth callback (`${APP_ORIGIN}/auth/callback`), the OAuth 2.1 issuer for MCP clients (`/_agentic/mcp`, `/.well-known/oauth-authorization-server`) and the A2A agent-card URLs — a wrong value fails sign-in with a `redirect_uri` mismatch at GitHub.

### 2.2 Register the GitHub OAuth app

GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**:

| Field | Value |
|---|---|
| Application name | anything, e.g. `agentic (production)` |
| Homepage URL | `APP_ORIGIN` |
| Authorization callback URL | `${APP_ORIGIN}/auth/callback` — exactly, no trailing slash |
| Enable Device Flow | off |

Register → copy the **Client ID**, then **Generate a new client secret** and copy it once (it is shown once). One OAuth app per deployment: the callback URL is fixed per app, so preview gets its own (§3).

The login requests `read:user user:email` (the provider reads `/user` and, when the profile e-mail is private, `/user/emails`). The first user to sign in owns the workspace `gh_<github id>`; there is no allow-list — every GitHub user who can reach the origin gets a workspace of their own (single-user workspaces, PRD §15).

### 2.3 Create the R2 bucket and its retention rule

```sh
cd apps/web
pnpm exec wrangler r2 bucket create agentic-artifacts
pnpm exec wrangler r2 bucket lifecycle add agentic-artifacts expire-artifacts --expire-days 30
```

The bucket name matches `r2_buckets[0].bucket_name` in `wrangler.jsonc`. The lifecycle rule is the enforcement of `Workspace.settings.retention.artifactDays` (default 30) — the platform never deletes artifacts itself (`docs/retention.md`); set the days to the number the deployment promises.

### 2.4 Generate and store every secret

Secrets go in with `wrangler secret put <NAME>` (production: no `--env`), which prompts for the value on stdin. Generate them on your machine; never commit or paste them into `wrangler.jsonc`.

| Secret | Generate with | Used for |
|---|---|---|
| `SESSION_SECRET` | `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` (≥ 32 chars) | signs the `__Host-session` cookie, OAuth transients and agent tokens |
| `WORKSPACE_KEK` | `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` (exactly 32 bytes, base64) | AES-GCM key sealing Registry secrets (BYO API keys); absent → `Registry.setSecret` refuses `no-kek` |
| `GITHUB_CLIENT_ID` | from §2.2 | the OAuth app |
| `GITHUB_CLIENT_SECRET` | from §2.2 | the OAuth app |
| `AGENTIC_DEV_LOGIN` | **do not set on production** | preview / local-only login (§3, §4) — while set, `/auth/dev-login` (a form on `GET`, JSON or the form on `POST`) mints a session for anyone holding the value |

```sh
cd apps/web
pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put WORKSPACE_KEK
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret list                      # names only, never values
```

There is no Anthropic key among them (decisions 2026-09-19 (b), #231): the `anthropic-api` runtime only ever uses the workspace's own `anthropic-api-key`, a Registry secret sealed under `WORKSPACE_KEK` and set at `/plugins/anthropic-api`. A deployment upgraded from before #231 ignores an `ANTHROPIC_API_KEY` secret it still has — `wrangler secret delete ANTHROPIC_API_KEY` tidies it away; each workspace enters its key once instead.

Without `SESSION_SECRET` the Worker serves pages but treats every actor call as anonymous (it logs a warning). The auth routes (`/auth/*`) mount only when `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `APP_ORIGIN` are all set.

Bindings that are not secrets (already in `wrangler.jsonc`): `ACTORS` (Durable Object binding, class `ActorHost`), `ARTIFACTS` (R2 bucket), `APP_ORIGIN` (var), `__DEV__` (`false`), `compatibility_flags: ["nodejs_compat"]`.

### 2.5 Durable Object migration

`migrations: [{ tag: "v1", new_sqlite_classes: ["ActorHost"] }]` is in `wrangler.jsonc` and applies itself on the first deploy — nothing to run by hand. Never edit that entry and never declare the class with `new_classes`: a class's storage backend cannot change after the first deploy (rules in §8).

### 2.6 Build and deploy

```sh
pnpm build                                            # at the repo root; packages first, then the app
cd apps/web
pnpm exec wrangler deploy --dry-run                    # the bundle offline: bindings, migrations, size — no upload
pnpm exec wrangler deploy                              # or, from the root: pnpm --filter @agentic/web deploy
```

The first deploy prints the `workers.dev` URL and creates the Durable Object namespace and the migration. A deploy restarts running objects: nothing saved is lost (every actor persists inside its turn), but live runtime sessions are interrupted and resume as "interrupted" (architecture §5a, OPS-05).

### 2.7 First login and smoke

1. `curl -sI ${APP_ORIGIN}/` → `200`, the SSR shell.
2. `curl -s ${APP_ORIGIN}/auth/me` → `401 {"error":"unauthorized"}`.
3. `curl -s -X POST ${APP_ORIGIN}/auth/dev-login` → `404`, and `GET` the same (the route must not exist on production).
4. Open `${APP_ORIGIN}/auth/login` in a browser → GitHub consent → back on `/` signed in. `GET /auth/me` now returns `{ principal: { kind: "user", userId: "gh_<id>", workspaceId: "…" } }`.
5. `/plugins/anthropic-api` → paste your Anthropic key → Ready. Then Agents → **New agent** → a name and role → the config tab shows v1 on the `anthropic-api` runtime → **Start chat** → post a message → the answer streams in. That is demo 1 by hand; §6 scripts it. Without the key the post's task fails `no-api-key` and names that page.

## 3. Preview environment

`env.preview` in `wrangler.jsonc` deploys a second worker, `agentic-web-preview`, with its own Durable Objects and R2 bucket, so preview data never touches production. It is where the scripted smokes run: they sign in through `POST /auth/dev-login`, which exists only while `AGENTIC_DEV_LOGIN` is set.

One-time setup:

```sh
cd apps/web
pnpm exec wrangler r2 bucket create agentic-artifacts-preview
pnpm exec wrangler r2 bucket lifecycle add agentic-artifacts-preview expire-artifacts --expire-days 30
pnpm exec wrangler secret put SESSION_SECRET --env preview
pnpm exec wrangler secret put WORKSPACE_KEK --env preview
pnpm exec wrangler secret put GITHUB_CLIENT_ID --env preview        # a second OAuth app, callback on the preview origin
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env preview
pnpm exec wrangler secret put AGENTIC_DEV_LOGIN --env preview       # ≥ 16 random chars; preview only
```

Set `env.preview.vars.APP_ORIGIN` to the URL wrangler prints on the first preview deploy (`https://agentic-web-preview.<subdomain>.workers.dev`) and register `${APP_ORIGIN}/auth/callback` on the preview OAuth app.

```sh
pnpm build
pnpm --filter @agentic/web deploy:preview:dry-run    # build + wrangler deploy --env preview --dry-run
pnpm --filter @agentic/web deploy:preview            # build + wrangler deploy --env preview
```

Smoke: `GET /` → 200; `GET /auth/me` → 401; `POST /auth/dev-login` with a wrong token → 403.

## 4. Local

One command from the repo root (`pnpm install` done):

```sh
pnpm dev
```

`scripts/dev.mjs` (Node only, Windows and Linux) does, in order:

1. **Secrets.** If `apps/web/.dev.vars` is missing it is generated: a random `SESSION_SECRET` (48 chars), `WORKSPACE_KEK` (base64 of 32 bytes) and `AGENTIC_DEV_LOGIN` (32 chars). No Anthropic key (#231): once signed in, add yours at `http://localhost:8787/plugins/anthropic-api` — it is sealed in the workspace's Registry under this `WORKSPACE_KEK` and survives restarts; the log prints the link. An existing file is never touched — deleting it to regenerate draws a new `WORKSPACE_KEK`, and every key stored under the old one can no longer be opened (enter it again). A file from before #231 may still carry `ANTHROPIC_API_KEY`: it is ignored (the log says so) and the line can be deleted by hand. `apps/web/.dev.vars.example` documents every line; `.dev.vars` stays ignored.
2. **Build.** `pnpm build` runs only when `apps/web/dist` is missing or older than any file under `apps/web/src` or `packages/*/src` (mtime check); `pnpm dev --rebuild` forces it. There is no hot reload of the Worker: after a source change, Ctrl+C and `pnpm dev` again.
3. **Serve.** `wrangler dev` over `dist/` on http://localhost:8787 (Durable Objects and R2 simulated) in the foreground, after printing the one-click sign-in link:

   ```
   [dev]     http://localhost:8787/auth/dev-login?token=<AGENTIC_DEV_LOGIN>
   ```

   Open it: `GET /auth/dev-login` is a small form (user name, the secret prefilled from `?token=` — on `localhost` / `127.0.0.1` only, a deployed preview never takes the secret from a URL) that signs you in as `dev_<user>` and lands on `/`. The shell's sidebar foot shows a **Dev login** button (and **Sign in with GitHub** when the OAuth app is configured) whenever nobody is signed in and the route is mounted; the route exists only while `AGENTIC_DEV_LOGIN` is set, so production has no such door. `/agents` renders live with an empty roster for a fresh identity.

   The log also says whether **GitHub login** is configured (both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.dev.vars`) — informational: the dev login and machine pairing never need it.

4. **Pair a machine against it** (#180). With only the generated secrets, the Worker still mounts `POST /auth/pair`, `GET /auth/me` and `POST /auth/logout` — they need the session secret alone; only `GET /auth/login` / `GET /auth/callback` wait for the GitHub app (and the OAuth 2.1 server for MCP clients needs an origin: `APP_ORIGIN` from `wrangler.jsonc`, or on `localhost` the request's own, so `--port` needs no config edit). Signed in through the dev login, open `/pair` and run the line it shows from the machine, for example:

   ```sh
   agentic-daemon pair <code> --url http://localhost:8787 --name <name>
   ```

   If the daemon says *the platform did not answer as JSON (HTTP 200, text/html …)*, the URL is not the agentic Worker (a static server, the Vite mock on port 3000, a proxy page): check `--url`.

Flags: `--rebuild`, `--port <n>` (the link follows), `--mock`. Other local commands:

```sh
pnpm dev:mock                                # the Vite dev server on mock data, no actors (apps/web/server.mjs, port 3000)
pnpm --filter @agentic/web test:workers      # the Worker + ActorHost inside workerd
pnpm --filter @agentic/web preview           # wrangler dev alone, when dist/ and .dev.vars are already there
```

With your key set at `/plugins/anthropic-api`, "New agent" → Config → "Start chat" → a message streams an answer from the platform-managed session (the manual check). The scripted version is the demo 1 smoke against the local Worker started by `pnpm dev` (§6): `BASE_URL=http://localhost:8787 AGENTIC_DEV_LOGIN=<the value in .dev.vars> ANTHROPIC_API_KEY=<your key> pnpm --filter @agentic/web smoke:demo1` — the key comes from the shell running the smoke, which stores it in the fresh workspace.

Every line of `apps/web/.dev.vars` (never committed):

```ini
SESSION_SECRET=<at least 32 random characters>
WORKSPACE_KEK=<base64 of 32 random bytes>
AGENTIC_DEV_LOGIN=<at least 16 random characters: mounts /auth/dev-login; never on production>
GITHUB_CLIENT_ID=<optional: an OAuth app whose callback is http://localhost:8787/auth/callback>
GITHUB_CLIENT_SECRET=<its secret>
```

## 5. Daemon on a Windows machine

The daemon (`apps/daemon`, architecture §5b) runs on the user's machine, pairs once, and keeps one outbound WebSocket to the platform. It ships as a self-contained zip; the machine needs nothing but Node.

### 5.1 Build the installer

On a Windows machine with the repo (the zip carries the Claude Code CLI for the platform it is built on — `win32-x64` when built on Windows):

```sh
pnpm build
pnpm --filter @agentic/daemon package        # → apps/daemon/release/agentic-daemon-<version>-win32-x64.zip
```

`apps/daemon/scripts/package.mjs` copies the built daemon, the production dependency closure (the `@agentic/*` packages as their `dist/`, `@anthropic-ai/claude-agent-sdk` with the native `claude.exe`), `install.ps1`, `uninstall.ps1`, the scheduled-task scripts and a README into one zip (~115 MB, no declarations or source maps). `apps/daemon/__tests__/package.test.ts` unpacks it and runs `agentic-daemon --version` and `doctor` on plain Node, so a green CI means the zip is self-contained.

### 5.2 Get a pairing code

Pairing codes come from `Workspace.registerMachinePending({ name })`: six characters, single use, valid 10 minutes; the daemon presents it to `POST /auth/pair` and receives the machine token.

Signed in, open **Machines → Pair a machine** (`/pair`, #144). The page mints a code the moment it opens, under the name in its **Machine name** field (`machine-N` by default — change it and a fresh code is minted under the new name, so the platform's record and the daemon agree), and shows two ready-to-copy lines that carry the code, this origin and the name:

- step 1, the installer: `powershell -ExecutionPolicy Bypass -File install.ps1 -Url <origin> -Code <code> -Name <name>` (§5.3);
- step 2, by hand: `agentic-daemon pair <code> --url <origin> --name <name>`.

The countdown runs from 10:00; at zero **New code** mints another. The page watches the record: as soon as the daemon redeems the code it moves to the machine's page. Without the browser (a script, a headless box), the same call over the actor mount while signed in:

```js
const { principal } = await (await fetch('/auth/me')).json();
const r = await fetch('/_sigx/actor/Workspace/registerMachinePending', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ args: [`ws:${principal.workspaceId}`, { name: 'my-desktop' }] })
});
console.log(await r.json());   // { machineId, pairingCode, expiresAt }
```

### 5.3 Install

On the machine, as the user who owns the Claude Code accounts:

1. Unpack the zip to a folder that stays put, e.g. `C:\agentic\daemon`.
2. Add one environment per Claude Code account (`docs/multi-account.md`) — no JSON by hand (#235): `node bin\agentic-daemon.mjs env add --name Work --root C:\src\work [--concurrency 2] [--account me@work.example]` writes `%APPDATA%\agentic\environments.json` (atomically, owner-only) and gives the environment its own profile folder `%APPDATA%\agentic\profiles\<id>`; `env list` and `env rm <id>` do the rest. Sign each one in once: `node bin\agentic-daemon.mjs env login <id>` runs `claude /login` under that profile (without the `claude` CLI on `PATH`: `--claude node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`). This step can also come after step 3: a daemon with no environments connects and reports none, a running daemon watches `environments.json` and announces a change within a second, and environments that are not signed in are re-checked every 30 s — none of it takes a restart. A hand edit that does not validate is logged (`environments.json is invalid; keeping the running environments`) and ignored. To let the Machine page add environments instead, allow the folders on the machine: `node bin\agentic-daemon.mjs policy allow-root C:\src` (off by default; the web never sees past those folders or into `%APPDATA%\agentic`; #238, `apps/daemon/README.md`).
3. In PowerShell, from the folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1 -Url https://agentic-web.<subdomain>.workers.dev -Code <pairing code>
   ```

   `install.ps1` checks Node ≥ 22.12, runs `agentic-daemon pair` (stores `%APPDATA%\agentic\credentials.json` owner-only), runs `agentic-daemon doctor` (pairing, `environments.json`, a driver per runtime, working roots, profile isolation and sign-in per profile — EXE-07), then registers the per-user Scheduled Task `agentic-daemon` (`scripts\install-service.ps1`: at logon, restarted a minute after any exit, never a LocalSystem service because the token and every `CLAUDE_CONFIG_DIR` belong to the user) and starts it.

4. Within a minute the machine is `online` on **Machines** with its environments, and its page (`/machines/:id`) lists the daemon's doctor verdicts per environment (`Machine.get()` / `Machine.doctor()`; the MCP surface's `machines_list` and `environments_doctor`). An agent's Config tab now offers those environments as its default environment.

Already paired (upgrade, or `pair` run by hand)? `install.ps1` with no arguments.

### 5.4 Doctor, logs, restart

```powershell
node bin\agentic-daemon.mjs doctor                                         # exit 1 on any error; the token is never printed
Get-ScheduledTask -TaskName agentic-daemon | Get-ScheduledTaskInfo         # LastRunTime, LastTaskResult
Get-Content -Wait "$env:LOCALAPPDATA\agentic\logs\daemon.log"              # JSON lines; redacted of the token
Stop-ScheduledTask -TaskName agentic-daemon; Start-ScheduledTask -TaskName agentic-daemon
```

| File | Where |
|---|---|
| `credentials.json` (machine token, owner-only ACL) | `%APPDATA%\agentic` |
| `environments.json` | `%APPDATA%\agentic` |
| session logs `{sessionId}.ndjson` (gapless replay after a reconnect) | `%LOCALAPPDATA%\agentic\sessions` |
| `daemon.log` | `%LOCALAPPDATA%\agentic\logs` |

`AGENTIC_DAEMON_HOME=<dir>`, set for the user before installing, puts credentials, environments and sessions in one directory (`install-service.ps1` honours it).

### 5.5 Upgrade and uninstall

- **Upgrade:** unpack the new zip to a new folder, run its `install.ps1` with no arguments — the pairing is reused, the task is stopped, re-registered to the new folder and restarted — then delete the old folder.
- **Uninstall:** `powershell -ExecutionPolicy Bypass -File uninstall.ps1` removes the task and keeps `%APPDATA%\agentic` and `%LOCALAPPDATA%\agentic`; delete them by hand. Revoke the machine on the platform (its page's **Revoke** card, or `Machine.revoke()`) so the token stops working — the next connect is refused and a revoked daemon redials forever at the backoff ceiling until re-paired.

## 6. Demo 1 smoke (`smoke:demo1`, #35)

Sign in, create an agent on the `anthropic-api` runtime, open a direct chat, post, watch the answer stream — as a Playwright spec (`apps/web/e2e/demo1.spec.ts`, config `playwright.demo1.config.ts`) against a deployed Worker. It signs in through the preview-only dev login, so the Worker needs `AGENTIC_DEV_LOGIN` set (§3); the Anthropic key comes from `ANTHROPIC_API_KEY` in the shell running the smoke, which stores it as the fresh workspace's `anthropic-api-key` (the Worker holds none, #231).

```sh
pnpm --filter @agentic/web exec playwright install chromium      # once
BASE_URL=https://agentic-web-preview.<subdomain>.workers.dev AGENTIC_DEV_LOGIN=<the preview secret> pnpm --filter @agentic/web smoke:demo1
```

On Windows PowerShell: `$env:BASE_URL='https://…'; $env:AGENTIC_DEV_LOGIN='…'; pnpm --filter @agentic/web smoke:demo1`.

The same smoke runs against the local Worker `pnpm dev` starts (§4; `AGENTIC_DEV_LOGIN` the value `apps/web/.dev.vars` holds, `ANTHROPIC_API_KEY` in your shell) as `BASE_URL=http://localhost:8787`. Without `ANTHROPIC_API_KEY` in the shell the smoke is skipped; with a bad key every step up to the post passes and the last assertion fails on the missing answer.

Each run signs in as a fresh `dev_demo1-<stamp>` identity (set `DEMO1_USER` to reuse one), so the roster starts empty and the recording shows the whole flow: the empty roster → "New agent" → Ada on the platform runtime → her Config tab, a saved version (v2 in the rail) → "Start chat" → the message → Ada's answer streaming in. Video is always recorded to `apps/web/test-results/demo1/**/video.webm` (the artefact the issue asks for); the HTML report lands in `apps/web/playwright-report/demo1`. The same walk-through runs offline in CI with the mock model: `apps/web/__tests__/pages/demo1-live.test.tsx` (the pages on the live harness) and `apps/web/__tests__/workers/demo1.test.ts` (dev login + the actors inside workerd).

## 7. Demo 2 smoke (Claude Code on a paired machine, #38)

Demo 2 has no scripted runner yet (`smoke:demo2` is the open half of #38); the platform half — Machine socket, routing, session relay, approvals, cancel — is pinned offline by `apps/web/__tests__/workers/daemon.test.ts`, the acceptance scenarios AC-01/02/07 (`test:acceptance`, #51) and `daemonConformance`. The manual run, recorded:

1. Deploy (§2 or §3) and install the daemon on a Windows machine (§5) with one environment, e.g. `env_work` on `C:/src/demo` — `doctor` green, the machine `online`.
2. Create an agent on the `claude-code` runtime with that environment as its default (`Agent.update({ execution: { runtime: 'claude-code', defaultEnvironmentId, offlinePolicy: 'queue', limits } }, reason)`; the agent form on the Agent page once §10 lands) and an approval rule for file writes (`docs/architecture.md` §7, #40).
3. Start a direct chat and post a task that writes a file under the working root — e.g. "create hello.md with a greeting".
4. On the machine: `daemon.log` shows `session.open` for `env_work`, then the session frames; on the platform the chat shows the session status and the tool call.
5. The write raises an approval: the chat shows the request card; approve it → the write happens and the turn ends with the file on disk. Deny one on a second prompt → the tool call fails `denied` and the turn ends without the file.
6. Post a long task and press **Cancel** in the chat → the daemon receives `session.command cancel`, the turn ends `cancelled`, the task is `cancelled`, no orphan `claude.exe` remains (`Get-Process claude`).
7. AC-15: an environment whose driver reports `resume: false` shows the limitation with the runtime's reason on the Session page; nothing offers Resume.
8. Stop the daemon task mid-turn and start it again: the session resumes from its NDJSON log with no gap (or shows `disconnected` with "events lost" if the log no longer covers the cursor), never a silent account or machine switch (AC-07, `offlinePolicy`).

Record the screen for steps 3–6 and link it from #38. (The cross-object hop hazard the acceptance suite found, #137 / #126, is fixed by PR #142: every `ActorHost` entry point is scoped to its own host, so two paired machines are fine.)

## 8. Durable Object migrations — read before changing `wrangler.jsonc`

- `ActorHost` is declared with `new_sqlite_classes` in migration `v1`. Never edit that entry, and never declare the class with `new_classes`: a class's storage backend cannot change after the first deploy.
- Renaming or deleting the class needs a NEW migration tag (`renamed_classes` / `deleted_classes`); deleting destroys every actor's state.
- An object's id derives from `type<NUL>key` (`durableObjectName`). Changing that derivation re-points every actor at an empty object — a data migration, not a config change.
- A deploy restarts running objects. `onDeactivate` never runs on Workers; actors persist inside each turn, so nothing saved is lost, but live runtime sessions are interrupted and resume as "interrupted" (architecture §5a).

## 9. Operate

### Logs and health

```sh
cd apps/web
pnpm exec wrangler tail [--env preview] [--status error]     # live Worker logs, including the ActorHost objects
pnpm exec wrangler deployments list [--env preview]
```

Health is `GET /` (200) and `GET /auth/me` (401 anonymous / 200 signed in). A machine's health is `Machine.get().online` plus `Machine.doctor()` (the daemon re-sends its verdicts on every `hello` and environment change).

### Rollback

```sh
cd apps/web
pnpm exec wrangler deployments list [--env preview]
pnpm exec wrangler rollback <version-id> [--env preview]
```

A rollback restores code, not Durable Object data. If the older version cannot read state a newer version wrote, roll forward instead. Secrets are not versioned with the code: a rotated secret stays rotated across a rollback.

### Rotate a secret

`wrangler secret put <NAME>` again; the new value reaches new isolates, so follow it with `wrangler deploy` to be sure every running one restarts. Consequences:

| Secret | Rotating it |
|---|---|
| `SESSION_SECRET` | signs everyone out; agent tokens and OAuth transients in flight become invalid. **Machine tokens keep working** — the Machine actor stores a SHA-256 of the token and verifies against that, not the secret |
| `WORKSPACE_KEK` | every stored Registry secret becomes unreadable — users must re-enter their BYO keys (`Registry.setSecret`); rotate only with a re-entry plan |
| `GITHUB_CLIENT_SECRET` | new logins use the new secret at once; existing sessions are unaffected |
| `AGENTIC_DEV_LOGIN` | the scripted smokes need the new value; unset it (`wrangler secret delete`) to remove the route |

Revoke a machine with `Machine.revoke()` (the daemon is refused on its next dial and every later one); a lost `credentials.json` on a machine is the same case — revoke, then re-pair.

### Expose agents over A2A (#245)

Off in every workspace until its owner turns it on:

1. `/plugins/agentic.a2a.server` → **Exposed agents**: the agents a remote client may see and give tasks to, by id or name → save → turn the plugin on.
2. The client signs in with OAuth exactly like an MCP client (same issuer, `${APP_ORIGIN}/.well-known/oauth-authorization-server`, dynamic registration, consent in the browser). Its grant needs the `tasks` and `sessions` scopes.
3. It reads the card at `${APP_ORIGIN}/_agentic/a2a/<agentId>/.well-known/agent-card.json` (or `${APP_ORIGIN}/.well-known/agent-card.json` while exactly one agent is exposed) and posts JSON-RPC to `${APP_ORIGIN}/_agentic/a2a/<agentId>` with `Authorization: Bearer <access token>`.

Every message is a task of that agent — in its runtime, under its approvals, in the audit with `origin: external`. What a client sees: 401 without a valid token, **404 for everything while the plugin is off** or for an agent that is not exposed, 403 `insufficient_scope` for a grant without `tasks` + `sessions`. v1 keeps a live A2A task and its context's history in the isolate that runs it: a streaming or blocking `SendMessage` is complete in one request, but a `GetTask` — or the answer to an `INPUT_REQUIRED` — that reaches another isolate does not find it (the platform task itself is durable and visible at `/tasks`).

### Retention, export, delete

`docs/retention.md`: what is stored where, the retention settings (`sessionLogDays` recorded but not swept in v1; `artifactDays` enforced by the R2 lifecycle rule from §2.3), `Workspace.exportAll()` (NDJSON under `{ws}/{stamp}/` in the `ARTIFACTS` bucket — the user-level backup) and `Workspace.deleteAll()` (the cascade that leaves no record). Durable Object SQLite storage has Cloudflare's own point-in-time recovery (30 days) reachable from code, not wired in v1; `exportAll` is the backup a user can take today.

### Bundle size

`wrangler deploy --dry-run` prints the Worker bundle size; `pnpm size` guards the client bundles (`.size-limit.json`). Static assets are served by the Worker's `assets` binding with `html_handling: none` — the document is always rendered.

## 10. Not wired yet

Kept honest: what a fresh deploy from this page does **not** give you, and where it lands.

| Seam | Today | Issue |
|---|---|---|
| Home's "Today" panel on the platform | every page reads the actors in live mode (`dataMode() === 'live'`; #144 the machine pages, #145 Schedules / Plugins / Settings, #146 Home, Tasks, History and Usage over the TaskIndex, the Audit log and the month's Ledger) except Home's "Today" panel, which does not read the schedules yet — the Schedules page lists them. Machine state is also `Machine.get()` / `Machine.doctor()`, or the MCP surface's `machines_list`, `environments_list`, `environments_doctor` | follow-up of #146 |
| Agent form on the platform: runtime, environment, approval rules, budgets | the New-agent dialog creates v1 on `anthropic-api`; other fields via `Agent.update(patch, reason)` | follow-up of #25 / #35 |
| Plugins beyond the runtimes | the build's plugins are listed and configured at `/plugins` and the runtimes are load-bearing (#229 – #231, #233: `Routing.run` gates on them, the `anthropic-api` key is the workspace's Registry secret); memory and learning follow the workspace's active plugin and its config (#242: turned off, a session retrieves, writes and learns nothing). Making another memory plugin active shows what moving the memories keeps and drops, then moves them (#243); the flat memory plugin is durable on its own FlatMemory actors under the scope's ACL (#281) and ships enabled, not active. The A2A server is mounted as a plugin, off by default (#245, §9 "Expose agents over A2A"), with live A2A task state per isolate; remote A2A agents as runtimes are not wired. Notification channels are still wired statically and a stored MCP connector is never read by a session | #240, #241, #244, #246 (decisions 2026-09-19) |
| Adding a working root from the web | the daemon answers `env.request` under its machine-local `policy.json` (#238: off until `agentic-daemon policy allow-root <dir>` or `pair --allow-root <dir>`, then roots only inside the allowed folders), but the Machine actor's request and the Machine page are not wired yet; until then a root is added on the machine — `agentic-daemon env add --id <id> --replace --name … --root …`, picked up without a restart (#235) | #237, #239 (decisions 2026-09-19 (c)) |
| `smoke:demo2` (mock driver in CI) and the recorded real run | §7 by hand; the platform half is pinned by `workers/daemon.test.ts` and AC-01/02/07 | #38 |
| Session-log sweeper for `retention.sessionLogDays` | the setting is recorded and exported, not enforced | follow-up on Session / Task (`docs/retention.md`) |
| Second Worker for the Durable Object host, so UI deploys do not evict live sessions | one Worker; a deploy interrupts live sessions, which resume as "interrupted" | follow-up (architecture §3) |
| macOS / Linux daemon install | the daemon runs there (`agentic-daemon run` in the foreground; `AGENTIC_DAEMON_HOME` for paths); no launchd / systemd unit and no zip for those platforms | decisions §2 |
| Chat read state across devices | unread counts on the chat list are device-local: the chat's `seq` when this browser last had it open, in `localStorage` (`apps/web/src/pages/chat/read-marks.ts`); another device, or cleared site data, starts from the chat's present end | #157 |
| Jump from a search hit to its message | "Search this chat" lists the hits (`Chat.search`, whole history) with who and when; the Thread's rows carry no DOM id, and a hit may be older than the entries the thread has loaded | follow-up on `@agentic/ui` Thread + "Load earlier" |
| Revoking a session grant | session grants are listed, not revocable — they end with the session (`SessionInfo.grants`: the adapter holds them and offers no way to take one back); the session page lists them read-only and draws no Revoke | — (#154) |
| Skills catalogue for the agent form | none: the Skills picker offers what the agent already has and takes a new id as typed (`SkillRef { id }`); nothing validates it | follow-up of #153 |
| Shared memory scope listing | none: the picker offers the agent's own shared scopes and takes a new name as typed; the Workspace keeps no scope index (the export cascade derives scopes from agent configs) | follow-up of #153 |
| Agent → Sessions tab: sessions past the task index | the tab lists the sessions of the agent's tasks in the `TaskIndex` (newest `TASK_INDEX_CAP` = 2000 tasks of the workspace); a session opened outside a task (none today) or older than the cap is not listed — open it by id (`/sessions/{id}`) | follow-up of #153 |
