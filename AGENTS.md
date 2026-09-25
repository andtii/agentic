# agentic — shared agent guide

> ⚠️ **BRANCH FIRST — never work on `main`.** Before touching ANY file, run
> `git branch --show-current`. If it prints a branch other than `main` and you are
> under `<repo>/branches/`, you are already isolated (a `pnpm wt` worktree or an
> agentic chat worktree): stay there and don't create another. Otherwise create a
> worktree (`pnpm wt new <N-short-slug>`) and do everything from
> `<repo>/branches/<N-short-slug>`. No `node_modules` in the worktree? Run
> `pnpm install`. This applies to every change, however small —
> editing or committing in the primary checkout (`<repo>/main`) causes conflicts
> for parallel sessions. Check yourself before every commit:
> `git branch --show-current` must print your worktree's branch name — if it
> prints `main` or nothing (detached HEAD), stop.
> Already edited files in `main` by mistake? Move the work, don't commit it:
> `git stash -u` → `pnpm wt new <N-short-slug>` →
> `cd <repo>/branches/<N-short-slug>` → `git stash pop`.

Canonical guidance for **any** AI agent working in this repo (Claude Code, GitHub
Copilot CLI, work agents, …). Tool-specific notes live in `CLAUDE.md`; it defers
here for everything shared.

This repo follows the sigx standard agent setup
([`signalxjs/repo-template`](https://github.com/signalxjs/repo-template)), tuned
for many agents at once: issue → worktree → `pnpm check` + local review → **one**
push → PR with Copilot as an advisory reviewer → auto-merge on the `gate` check.
Nobody approves by hand (`--approvals 0`) and review threads do not block merge;
the one required check is CI's `gate`.

## What this repo is

`andtii/agentic` is the **Unified Agent Platform**: persistent AI agents with
identity, memory, skills and permissions; direct and group chats; delegation with
tracked tasks; installed CLI runtimes driven through machine daemons; API-based
agents; A2A + MCP interop; scheduling; Cloudflare hosting; responsive web UI.

It is a pnpm monorepo (ESM, `"type": "module"`) of private `@agentic/*` packages
built on the sigx estate: `@sigx/ai-agent` (agent contract, adapters, wire),
`@sigx/actors` + `@sigx/actors-cloudflare` (persistent state on Durable Objects),
`@sigx/zero` + `@sigx/zero-daisyui` (UI), sigx core (SSR, serverFn, router).
Tech stack: TypeScript (strict), Vite, Vitest, oxlint. Nothing is published.

**Read these before any work:** `docs/requirements.md` (the PRD, requirement IDs
like `COL-05`), `docs/architecture.md` (the design every issue implements),
`docs/decisions.md`, `docs/promotion.md`.

## Picking up an issue

All work is tracked as sub-issues of the tracking issue
(`gh issue list --label tracking`). Each sub-issue is written for a cold start.

1. Pick an open sub-issue without the `blocked` label whose **Depends on** issues
   are merged. Comment "taking this" so no other agent starts it.
2. Already in a worktree under `<repo>/branches/` (not on `main`)? Stay there.
   Otherwise `pnpm wt new <N-short-slug>` from `<repo>/main`; work only inside
   `<repo>/branches/<N-short-slug>`. No `node_modules`? `pnpm install`.
   `git branch --show-current` must never print `main`.
3. Read, in this order: the issue body, the `docs/architecture.md` section it
   names, the requirement IDs it lists in `docs/requirements.md`. Do not read the
   tracking thread — the issue body is complete by design.
4. **Contract first.** If the issue needs a type or seam that `packages/core`
   lacks, open a separate small PR against `packages/core` first (label
   `contract`), merge it, then continue. Never add a cross-package type anywhere
   else.
5. **File ownership.** Touch only the paths listed under **Owner paths** in the
   issue, plus your own section of `docs/architecture.md` and a line in
   `docs/promotion.md`. Need another package changed? Stop and file a follow-up
   issue instead of editing it.
6. **Zero feedback.** When `@sigx/zero` blocks you (missing part, state, binding),
   file an issue on `signalxjs/zero` labelled `from:agentic`, link it from your
   issue, and use the smallest local workaround in the package that owns the
   code, with a `docs/promotion.md` line naming the zero issue. Never patch
   `node_modules` or vendor zero.
7. **Promotion.** Anything generic you write stays in the package the issue names
   and gets one line in `docs/promotion.md`.
8. **Definition of done:** `pnpm check` green (typecheck, lint, the unit tests
   your diff reaches, size and scripts when touched); new tests for new
   behaviour; the issue's acceptance checklist ticked in the PR body;
   `docs/architecture.md` updated if a seam changed. No `CHANGELOG.md` entries:
   the PR title and body are the record, and release notes are drafted from PR
   titles (the files are frozen history).
9. **PR, Copilot review, merge** — the full loop is under "Development
   workflow" below (Claude Code: the `take-issue` skill runs it). In short:
   ```sh
   pnpm check                                   # then the local review, then ONE push
   gh pr create --base main --title "<area>: <what>" --body "Closes #N. <summary>" --reviewer @copilot
   # Copilot (≤5 min): fix only real bugs, in ONE commit
   gh pr merge <pr> --auto --squash --delete-branch \
     --subject "$(gh pr view <pr> --json title -q .title) (#<pr>)" \
     --body "$(gh pr view <pr> --json body -q .body)"
   ```
   Pass `--subject`/`--body` explicitly so GitHub adds no generated trailers.

## Development workflow (issue → worktree → check → one push → auto-merge)

Mandatory for every agent-driven change, including one-line fixes. Never commit
straight to `main` — it is protected (PR, the `gate` check green, squash only;
`scripts/apply-branch-protection.mjs` is the ruleset as code, `pnpm
branch-protection` re-applies it). A branch need **not** be up to date with
`main` to merge (`--no-strict`, #685); rebase only on a real conflict.

**Every push costs a CI run, so push once.** The loop is built so review
happens *before* the push, not after it:

0. **`main` red?** `gh issue list --label main-red --state open`. An open one
   means `main` is broken: fix it (or wait for whoever took it) before starting
   anything else. The main-branch CI opens it automatically.
1. **Issue first.** If no issue tracks the work, create one before writing code
   with the plan in its body (`.github/ISSUE_TEMPLATE/task.md` is the shape).
   Claim an existing one: comment "taking this" and add the `in-progress` label.
2. **Worktree, always** — the one you are in if it is under `<repo>/branches/`
   and not on `main`, else `pnpm wt new <N-short-slug>`. Never `git switch -c`
   in `<repo>/main` — parallel sessions share it.
3. **Implement.** Bug fix → write the failing test first (red), then fix
   (green). Stage specific files (`git add <path>`), never `git add -A`. No
   co-author trailers.
4. **`pnpm check`** — the local gate (`scripts/check.mjs`): typecheck, lint,
   `vitest --changed origin/main`, plus build + size when a size-limited
   package changed and the scripts tests when `scripts/` changed. `--workers`
   adds workerd, `--all` the whole unit suite. `git fetch` first.
5. **Review locally, before pushing.** Claude Code: the `code-review` skill on
   the diff (low effort); other agents: an equivalent self-review of the diff
   for correctness bugs, missing tests and layering breaks. Fix what it finds,
   re-run `pnpm check`.
6. **Push once and open the PR, Copilot as reviewer.** `Closes #N` in the body;
   the body becomes the squash commit body verbatim, the title (with ` (#<pr>)`
   appended) its subject — write them as the commit you want on `main`.
   ```sh
   gh pr create --base main --title "<area>: <what>" \
     --body "Closes #N. <summary>" --reviewer @copilot
   ```
   If `gh` cannot resolve `@copilot` (`'@copilot' not found`), request it via
   the API: `gh api --method POST repos/andtii/agentic/pulls/<pr>/requested_reviewers
   -f 'reviewers[]=copilot-pull-request-reviewer[bot]'`.
   **Rebase early on a conflict.** GitHub runs no `pull_request` CI on a PR it
   cannot compute a merge ref for (`mergeable_state: dirty`). When `gh pr view
   <pr> --json mergeStateStatus` says `DIRTY`, `git fetch && git rebase
   origin/main` right away (then `git push --force-with-lease`).
7. **Copilot is advisory — one pass.** It reviews in a minute or two, while CI
   runs (`gh pr view <pr> --json reviews -q '.reviews[].author.login'`; give it
   up to ~5 minutes, then move on). Fix **only** correctness bugs, security
   issues, contract/layering breaks and missing tests — all of them in **one**
   commit, one push. Style, naming and wording nits: leave them. Threads need
   no resolving; a one-line reply ("fixed in <sha>" / "won't fix: nit") is
   courtesy, not a gate. Do not re-request a review after the fix.
8. **Auto-merge.** `gh pr merge <pr> --auto --squash --delete-branch --subject
   "<title> (#<pr>)" --body "<body>"` — it merges itself the moment `gate` is
   green. Pass `--subject`/`--body` explicitly: GitHub appends
   `Co-authored-by:` trailers to any message it generates itself. Once merged:
   `pnpm wt rm <N-short-slug>`. `gate` red? Read the failing lane
   (`gh pr checks <pr>`), fix, push once more.

### What CI runs (`.github/workflows/ci.yml`)

- **On a PR**, only the lanes the diff can break (`scripts/ci-changes.mjs`
  decides; docs-only PRs run nothing): `static` (lint, catalog, typecheck,
  scripts tests), `unit` (the vitest suite in 4 shards), `workers` (workerd +
  acceptance, when web/platform-side code changed), `e2e` (phone + desktop in 2
  shards, when web/ui/platform/core changed), `size` (when core/ui/connectors/
  plugins-git changed). `gate` aggregates them — the only required check.
- **On `main` and nightly**, everything: plus Windows and Node 20 (`compat`),
  e2e at all three widths and coverage. A red run opens or comments on a
  `main-red` issue — see step 0.

## Build, Test, Lint

```bash
pnpm install
pnpm build            # every package (vite dev + prod dists, d.ts)
pnpm test             # vitest run
pnpm test <path>      # single file/dir (substring match; no `--`)
pnpm test -t "name"   # single test by name
pnpm test:coverage
pnpm typecheck        # tsc --noEmit over packages/*/src, __tests__, apps/*/src
pnpm lint             # oxlint packages apps
pnpm size             # size-limit (.size-limit.json)
pnpm check            # the pre-push gate for this diff (scripts/check.mjs; --all, --workers)
pnpm verify:catalog   # single-minor core catalog guard (CI runs it too)
pnpm test:scripts     # node --test for scripts/
pnpm --filter @agentic/web test:workers  # Worker + ActorHost DO inside workerd (Node >= 22)
```

Run the web app: `pnpm dev` (the real Worker on `wrangler dev`, http://localhost:8787,
`.dev.vars` generated, dev-login link printed — `docs/runbook.md` §4) or
`pnpm dev:mock` (Vite on mock data). Run the daemon: `pnpm --filter @agentic/daemon start`.

## Packages

| Path | Package | What it is |
|---|---|---|
| `packages/core` | `@agentic/core` | edge-safe contracts: ids, config, chat entries, task lifecycle, environments, capabilities, plugin manifests, memory/learning interfaces, daemon frames, principals — zero deps |
| `packages/platform` | `@agentic/platform` | `defineActor` definitions: Workspace, Agent, Chat, Task, Session, Machine, Schedule, Memory, Inbox, Ledger, Registry, Audit; auth helpers |
| `packages/runtimes` | `@agentic/runtimes` | runtime adapters (`anthropic-api` via `modelAgent`, `claude-code` daemon driver) and platform tools |
| `packages/memory` | `@agentic/memory` | default MemoryPlugin + `memoryConformance` |
| `packages/learning` | `@agentic/learning` | default LearningPlugin |
| `packages/plugins-git` | `@agentic/plugins-git` | git project feature plugin: detect, origin identity, instructions, worktree per chat |
| `packages/connectors` | `@agentic/connectors` | native connectors over conduit: the engine with injected stores, operations as namespaced connector tools, connector manifests (Gmail first) |
| `packages/daemon-protocol` | `@agentic/daemon-protocol` | envelope validators + `daemonConformance` |
| `packages/ui` | `@agentic/ui` | zero fragment (`ai-*` scopes), layout shell, streaming markdown |
| `packages/mcp` | `@agentic/mcp` | MCP client + platform MCP server (orchestration surface) |
| `packages/a2a` | `@agentic/a2a` | A2A 1.0 server + client adapter |
| `apps/web` | `@agentic/web` | sigx SSR app + actors host on Cloudflare Workers |
| `apps/daemon` | `@agentic/daemon` | `agentic-daemon` machine daemon (Windows first) |

Path aliases: `tsconfig.json` and `vitest.config.ts` map `@agentic/*` to
`packages/*/src`, so tests and typecheck run against source, not dist.

Layering (imports point downward only): core ← daemon-protocol ← memory /
learning ← runtimes ← platform ← apps. `packages/*` never import the `sigx`
umbrella — peer on `@sigx/runtime-core` / `@sigx/reactivity` / `@sigx/actors`
so they stay edge-safe; only `apps/web` and `packages/ui` touch the DOM.

## Parallel work with git worktrees

```sh
pnpm wt new <name> [--from <branch>]   # worktree at <repo>/branches/<name>: own branch + deps installed
pnpm wt list
pnpm wt rm <name> [--force]
```

Primary checkout at `<repo>/main`, every worktree at `<repo>/branches/<name>`.
Launch a separate agent session from the worktree directory.

## Documentation

In-repo docs ship in the same PR:

| When you… | Update… |
|---|---|
| add / rename / remove a package | this file's "Packages", `tsconfig.json` paths, `vitest.config.ts` aliases, `.size-limit.json` |
| change a build / test / lint script | "Build, Test, Lint" here and `package.json` |
| change a seam or actor contract | the matching section of `docs/architecture.md` |
| take a product decision the PRD leaves open | `docs/decisions.md` |
| write something generic | one line in `docs/promotion.md` |
| change public behaviour of a package | its `README.md` (and say so in the PR body — no `CHANGELOG.md` entry) |

There is no docs site for this repo.

## Conventions & working principles

- **Plan first for non-trivial work**; the approved plan is the issue body.
- **Verify before declaring done** with typecheck/tests and evidence.
- **Test-first bug fixes**: failing test first, then the fix.
- **Minimal, surgical edits.** No refactors of unrelated code, no compat shims for things that never shipped.
- **Edge-safe by default**: no `node:` imports in `packages/*` except where the package is Node-only by design (`apps/daemon`, the stdio MCP client).
- **Workers eviction rule**: `onDeactivate` never runs on Cloudflare — every actor mutation ends in `ctx.save()` / `ctx.append()` inside the turn.
- **Cross-platform**: contributors and CI run Windows and Linux — prefer Node scripts over shell one-liners.
- **Git hygiene**: `git add <path>`, never `-A`; `pnpm typecheck` before any `.ts` commit; no co-author trailers.
- **`__DEV__`-gate** dev-only code (defined by the build and by vitest).
