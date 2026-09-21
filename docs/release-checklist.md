# First-release checklist

The gates for tagging the first release of the Unified Agent Platform (tracking issue #11, phase 3). Every box is a fact someone can verify, with the command or the artefact that proves it; tick them in the release PR. Status per sub-issue lives in the tracking-issue comment this checklist was published with (#52).

## Gates

### Code

- [ ] CI green on `main` for the release commit: `lint`, `verify:catalog`, `typecheck`, `build`, `test`, `test:workers` (Node 22, Windows + Linux), `test:acceptance`, Playwright e2e, bundle size (`pnpm size`), coverage upload.
- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm size` green locally on Windows and Linux (contributors run both).
- [ ] Release notes reviewed in the release-drafter draft (from PR titles; `CHANGELOG.md` files are frozen history, not updated per PR), and `version` bumped consistently (`@agentic/daemon` and `DAEMON_VERSION` in `apps/daemon/src/version.ts` — the installer zip and `hello.daemonVersion` carry it).
- [ ] `pnpm verify:catalog` passes: every `@sigx/*` package on one core minor; no local checkout linked.

### Acceptance

- [ ] Acceptance suite (#51, PR #138): every AC id of requirements §17 maps to a spec under `apps/web/__tests__/acceptance/` or a manual entry in `docs/acceptance.md`; `pnpm --filter @agentic/web test:acceptance` green; no `it.fails` left (AC-09's gap #135 landed in PR #141).
- [ ] Manual checklist M1–M4 in `docs/acceptance.md` run on real machines (two machines, three accounts on one machine, return on a phone, push delivery) and the results recorded in the release PR.

### Demos

- [ ] Demo 1 recorded (#35): `smoke:demo1` against the preview Worker, a real `ANTHROPIC_API_KEY` in the shell running it (stored as the workspace key, #231) — `apps/web/test-results/demo1/**/video.webm` attached to the issue (`docs/runbook.md` §6).
- [ ] Demo 2 recorded (#38): the manual run of `docs/runbook.md` §7 on a paired Windows machine — approval round trip, deny, cancel, restart mid-turn — screen recording linked from the issue. `smoke:demo2` with the mock driver in CI, or the issue re-scoped to say why not.

### Deploy

- [ ] A fresh production deploy from `docs/runbook.md` §2 by someone other than the author reaches §2.7 step 5 (an agent answers in a chat) without reading anything else; every gap found is fixed in the runbook, not worked around.
- [ ] The daemon installer built by `pnpm --filter @agentic/daemon package` installs on a clean Windows machine with only Node present (`docs/runbook.md` §5): `install.ps1 -Url … -Code …` pairs, `doctor` is green, the machine is online within a minute, `uninstall.ps1` removes the task.
- [ ] `apps/web/wrangler.jsonc` top-level `vars.APP_ORIGIN` is the production origin (not `http://localhost:8787`) and the GitHub OAuth app's callback matches it.
- [ ] `AGENTIC_DEV_LOGIN` is **not** set on production (`wrangler secret list` shows no such name; `POST /auth/dev-login` → the HTML shell, never JSON or a `set-cookie`; runbook §2.7).

### Secrets and data

- [ ] Every secret of `docs/runbook.md` §2.4 generated fresh for production — never reused from preview, local `.dev.vars`, or a chat transcript — and rotated once more if any of them was ever pasted anywhere outside `wrangler secret put`.
- [ ] `WORKSPACE_KEK` backed up in the operator's password manager (rotating it makes every stored BYO key unreadable).
- [ ] R2 lifecycle rule on `agentic-artifacts` matches `retention.artifactDays` (default 30); `docs/retention.md` reviewed and still true (what is stored, `exportAll`, `deleteAll`, the deferred session-log sweeper).
- [ ] Durable Object migration list in `wrangler.jsonc` unchanged since the first deploy (`v1`, `new_sqlite_classes: ["ActorHost"]`).

### Docs

- [ ] `docs/decisions.md` answers every requirements §18 open decision (table dated 2026-09-18) and any decision taken since is a new row.
- [ ] `docs/promotion.md` reviewed: every generic piece still has a row and a destination; nothing on the list has been lifted upstream without the row being removed.
- [ ] `docs/runbook.md` §10 "Not wired yet" is accurate for the release commit — every row names an issue or a follow-up; nothing shipped is listed, nothing listed shipped.
- [ ] `docs/architecture.md` matches the code for every seam the release depends on (a reader following §5a and §5b finds the files named).
- [ ] Each package `README.md` describes the shipped behaviour (the daemon README names `--version`, the installer and the scheduled task).

### Known issues carried into the release

Each must be open with a label, linked from the release notes, and — where it affects production — mitigated in the runbook:

- [ ] #129 — the Cloudflare adapter's entry emits non-handler re-exports (the `worker.mjs` façade is the workaround; `main` must stay on it).
- [ ] The ops pages (Machines, Machine, Pair, Schedules, Plugins, Settings, History, Usage, Tasks, Home) render mock data in production; pairing codes come from the console call in `docs/runbook.md` §5.2.

## Release

- [ ] Tag `v0.1.0` on the release commit; release-drafter's notes reviewed, the known issues above listed under "Known issues".
- [ ] Tag the daemon: `git tag daemon-v<semver> && git push origin daemon-v<semver>` (or **Actions → Daemon release → Run workflow** with `tag: daemon-v<semver>`). The tag workflow attaches the five zips and their `.sha256` files and a `manifest.json` to the release `daemon-v<semver>` — nothing is attached by hand (`docs/runbook.md` §5.1).
- [ ] Check the manifest: `version` is the tag's semver, `channel` is `stable`, five `assets` (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), each `sha256` equal to its `.sha256` file; `agentic-daemon --version` from one zip prints the same version and commit.
- [ ] Check the channel: `daemon-stable`'s `manifest.json` is the same file (a `-rc` tag leaves it alone), and its notes name the new version.
- [ ] Once the first stable daemon release exists, switch `DEFAULT_CHANNEL` in `apps/web/public/install.sh` and `$DefaultChannel` in `install.ps1` to `stable`.
- [ ] Tracking issue #11 updated with the per-sub-issue status and closed, or kept open with the follow-up list as its last comment.
