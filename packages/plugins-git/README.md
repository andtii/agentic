# @agentic/plugins-git

The git project feature plugin (#335; EXE-02, EXE-12, PLG-01, PLG-02): the first `ProjectFeaturePlugin` of `@agentic/core`. Edge-safe, depends on `@agentic/core` only, runs on the platform's router; it composes the daemon's generic folder operations and ships no daemon code or UI.

Design: `docs/architecture.md` §9 (project feature plugins) and §7 (feature hooks at placement).

## What it does

| Hook | Behaviour |
|---|---|
| `manifest` | id `agentic.feature.git`, kind `project-feature`, nothing workspace-wide to configure |
| `detect(folder)` | true when the daemon's listing gave the folder a git badge (a repo or a worktree) |
| `identityOf(folder)` | the badge's `origin`: the repo's identity across machines (compared with `sameOrigin`); the project form fills the `origin` setting from it |
| `instructions(ctx)` | the project's `instructions` text, trimmed, into every session's `## Project` section |
| `beforeSession(input)` | with `worktreePerChat` on and a task from a chat: one `worktree` op per chat and environment, and the session opens in the worktree |

## Per-project settings (`features['agentic.feature.git']`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `origin` | string | — | the origin remote URL as git writes it (`https://…` or `git@host:path`) |
| `worktreePerChat` | boolean | `false` | give each chat its own branch and worktree |
| `branchPrefix` | string | `chat/` | what a chat's branch name starts with |
| `base` | string | — | the start point of a new chat branch; the checkout's HEAD when empty |
| `instructions` | string | `''` | how to work in this repo |

## The worktree rule

`branch = branchPrefix + short chat id` (the last 8 characters after `chat_`, lowercased) — the same on every environment of the chat, checked against a conservative subset of git's ref-name rules (`gitBranchFor`, `isValidBranchName`). `path = suggestWorktreePath(cwd, branch)` from `@agentic/core`: beside a checkout named `main` under `branches/`, a sibling of a worktree already under `branches/`, else `<repo>-worktrees/<slug>`; the OS is read from the folder's shape (`hostOsOfPath`). The plugin sends `{ kind: 'worktree', repo: cwd, branch, path, base? }` to the environment's daemon and returns the daemon's path as the session's `cwd`, plus one line for the prompt: ``This chat works on branch `…` in `…`.``

Nothing is remembered between tasks: a second task of the same chat (or the same chat after a restart) sends the same op and the daemon answers `branch-exists` or `exists`, which resolve deterministically to the same path. Any other daemon error (`not-a-repo`, `outside-roots`, `timeout`, `unsupported`, …) throws `git worktree <code>: <message>`, so the router parks the task `waiting { kind: 'project-feature' }` with that message and a later `Routing.run` tries again (EXE-12).

Out of scope here: push/pull, PR creation, worktree cleanup when a chat is deleted, clone.

## Layout

| File | What |
|---|---|
| `src/index.ts` | `gitFeaturePlugin`, `gitFeatureManifest`, `gitProjectSettings`, `GIT_FEATURE_ID`, `gitBranchFor`, `isValidBranchName`, `hostOsOfPath`, `identityOf` |
| `__tests__/git.test.ts` | the manifest, detect / identity / instructions, and `beforeSession` against a recording fake daemon |

The router end to end (two machines, reuse, parking) is covered in `packages/platform/__tests__/routing/projects.test.ts`.
