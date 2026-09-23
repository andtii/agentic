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
([`signalxjs/repo-template`](https://github.com/signalxjs/repo-template)): issue →
worktree → PR with Copilot as reviewer → threads resolved → green CI →
squash-merge. Nobody approves by hand (`--approvals 0`), but the ruleset requires
every review thread to be resolved, so a PR that skips the Copilot step stalls at
merge however green it is.

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
   the PR body; `docs/architecture.md` updated if a seam changed. No
   `CHANGELOG.md` entries: the PR title and body are the record, and release
   notes are drafted from PR titles (the files are frozen history).
9. **PR, Copilot review, merge** — the full loop is under "Development
   workflow" below. In short:
   ```sh
   gh pr create --base main --title "<area>: <what>" --body "Closes #N. <summary>" --reviewer @copilot
   gh pr checks <pr> --watch
   # wait for copilot-pull-request-reviewer, fix what it raises, resolve every thread
   gh pr merge <pr> --squash --delete-branch \
     --subject "$(gh pr view <pr> --json title -q .title) (#<pr>)" \
     --body "$(gh pr view <pr> --json body -q .body)"
   pnpm wt rm <N-short-slug>
   ```
   Pass `--subject`/`--body` explicitly so GitHub adds no generated trailers.

## Development workflow (issue → worktree → PR → Copilot review → merge)

Mandatory for every agent-driven change, including one-line fixes. Never commit
straight to `main` — it is protected (PR, resolved review threads, green CI,
squash only; `scripts/apply-branch-protection.mjs` is the ruleset as code).

1. **Issue first.** If no issue tracks the work, create one before writing code
   with the plan in its body (`.github/ISSUE_TEMPLATE/task.md` is the shape).
2. **Worktree, always** (`pnpm wt new <N-short-slug>`). Never `git switch -c`
   in `<repo>/main` — parallel sessions share it.
3. **Implement and verify.** Bug fix → write the failing test first (red), then
   fix (green). `pnpm typecheck` for any `.ts`; relevant `pnpm test` / `pnpm build`.
   Stage specific files (`git add <path>`), never `git add -A`. No co-author
   trailers.
4. **Open the PR with Copilot as the reviewer.** `Closes #N` in the body; the
   body becomes the squash commit body verbatim, the title (with ` (#<pr>)`
   appended) its subject — write them as the commit you want on `main`.
   ```sh
   gh pr create --base main --title "<area>: <what>" \
     --body "Closes #N. <summary>" --reviewer @copilot
   ```
   On an already-open PR: `gh pr edit <pr> --add-reviewer @copilot`. If `gh`
   cannot resolve `@copilot` (`'@copilot' not found`), request it via the API —
   don't skip it:
   ```sh
   gh api --method POST repos/andtii/agentic/pulls/<pr>/requested_reviewers \
     -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
   ```
5. **Wait for Copilot's review, then fix.** The bot
   `copilot-pull-request-reviewer` reviews within a minute or two; do not merge
   before it has.
   ```sh
   gh pr view <pr> --json reviews -q '.reviews[].author.login'   # wait for "copilot-pull-request-reviewer"
   gh pr view <pr> --json reviews,comments
   ```
   Address every actionable comment with follow-up commits and push. If the
   review doesn't re-trigger, re-request it: `gh pr edit <pr> --add-reviewer @copilot`.

   **Then resolve the threads.** The ruleset sets
   `required_review_thread_resolution`, so a PR carrying an unresolved inline
   comment cannot merge however green it is — `gh pr merge` just says BLOCKED and
   `gh pr checks` shows nothing wrong. Pushing a fix does not resolve a thread,
   nor does replying at PR level. There is no `gh pr` porcelain — reply on each
   thread and resolve it over GraphQL:
   ```sh
   # list the open threads
   gh api graphql -f query='query { repository(owner:"andtii", name:"agentic") {
     pullRequest(number:<pr>) { reviewThreads(first:100) { nodes {
       id isResolved comments(first:1){nodes{body}} } } } } }' \
     -q '.data.repository.pullRequest.reviewThreads.nodes[]
         | select(.isResolved==false) | "\(.id) \(.comments.nodes[0].body[0:60])"'

   # reply (say which commit fixed it, or why it stays), then resolve — pass the
   # body as a GraphQL variable, not string-interpolated
   gh api graphql -f query='mutation($t:ID!,$b:String!){
     addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){ comment { id } } }' \
     -f t="<thread-id>" -f b="Fixed in <sha>. <what changed>"
   gh api graphql -f query='mutation($t:ID!){
     resolveReviewThread(input:{threadId:$t}){ thread { isResolved } } }' -f t="<thread-id>"
   ```
6. **Merge it yourself** once the threads are resolved and CI is green — squash
   (repo rules block merge commits), delete the branch, remove the worktree:
   ```sh
   pr=123
   gh pr checks "$pr"                         # all green, including e2e and size
   gh pr merge "$pr" --squash --delete-branch \
     --subject "$(gh pr view "$pr" --json title -q .title) (#$pr)" \
     --body "$(gh pr view "$pr" --json body -q .body)"
   pnpm wt rm <N-short-slug>
   ```
   Pass `--subject`/`--body` explicitly: GitHub appends `Co-authored-by:`
   trailers to every message it generates itself whenever a branch-commit author
   differs from the merging account; an explicit message is used verbatim.

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
