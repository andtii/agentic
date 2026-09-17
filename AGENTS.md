# agentic — shared agent guide

> ⚠️ **BRANCH FIRST — never work on `main`.** Before touching ANY file, create a
> worktree (`pnpm wt new <N-short-slug>`) and do everything from
> `<repo>/branches/<N-short-slug>`. This applies to every change, however small —
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
([`signalxjs/repo-template`](https://github.com/signalxjs/repo-template)) with one
deliberate deviation: **there is no Copilot review step**. PRs merge on green CI.

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
2. `pnpm wt new <N-short-slug>` from `<repo>/main`; work only inside
   `<repo>/branches/<N-short-slug>`. `git branch --show-current` must never print
   `main`.
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
   file an issue on `andtii/zero-wip` labelled `from:agentic`, link it from your
   issue, and use the smallest local workaround under
   `packages/ui/src/_zero-gaps/`. Never patch `node_modules` or vendor zero.
7. **Promotion.** Anything generic you write stays in the package the issue names
   and gets one line in `docs/promotion.md`.
8. **Definition of done:** `pnpm typecheck && pnpm lint && pnpm test && pnpm size`
   green; new tests for new behaviour; the issue's acceptance checklist ticked in
   the PR body; `docs/architecture.md` updated if a seam changed; a CHANGELOG
   `[Unreleased]` entry in each touched package.
9. **PR and merge:**
   ```sh
   gh pr create --base main --title "<area>: <what>" --body "Closes #N. <summary>"
   gh pr checks <pr> --watch
   gh pr merge <pr> --squash --delete-branch \
     --subject "$(gh pr view <pr> --json title -q .title) (#<pr>)" \
     --body "$(gh pr view <pr> --json body -q .body)"
   pnpm wt rm <N-short-slug>
   ```
   Pass `--subject`/`--body` explicitly so GitHub adds no generated trailers.

## Development workflow (issue → worktree → PR → CI → merge)

Mandatory for every agent-driven change, including one-line fixes. Never commit
straight to `main` — it is protected (PR + green CI required, squash only).

1. **Issue first.** If no issue tracks the work, create one before writing code
   with the plan in its body (`.github/ISSUE_TEMPLATE/task.md` is the shape).
2. **Worktree, always** (`pnpm wt new <N-short-slug>`).
3. **Implement and verify.** Bug fix → write the failing test first (red), then
   fix (green). `pnpm typecheck` for any `.ts`; relevant `pnpm test` / `pnpm build`.
   Stage specific files (`git add <path>`), never `git add -A`. No co-author
   trailers.
4. **Open the PR** with `Closes #N` in the body; the body becomes the squash
   commit body verbatim.
5. **Merge on green** with the explicit subject/body shown above.

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
pnpm verify:catalog   # single-minor core catalog guard (CI runs it too)
pnpm test:scripts     # node --test for scripts/
pnpm --filter @agentic/web test:workers  # Worker + ActorHost DO inside workerd (Node >= 22)
```

Run the web app: `pnpm --filter @agentic/web dev`. Run the daemon:
`pnpm --filter @agentic/daemon start`.

## Packages

| Path | Package | What it is |
|---|---|---|
| `packages/core` | `@agentic/core` | edge-safe contracts: ids, config, chat entries, task lifecycle, environments, capabilities, plugin manifests, memory/learning interfaces, daemon frames, principals — zero deps |
| `packages/platform` | `@agentic/platform` | `defineActor` definitions: Workspace, Agent, Chat, Task, Session, Machine, Schedule, Memory, Inbox, Ledger, Registry, Audit; auth helpers |
| `packages/runtimes` | `@agentic/runtimes` | runtime adapters (`anthropic-api` via `modelAgent`, `claude-code` daemon driver) and platform tools |
| `packages/memory` | `@agentic/memory` | default MemoryPlugin + `memoryConformance` |
| `packages/learning` | `@agentic/learning` | default LearningPlugin |
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
| change public behaviour of a package | its `README.md` and `CHANGELOG.md` `[Unreleased]` |

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
