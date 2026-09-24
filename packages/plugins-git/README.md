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
| `branchTemplate` | string | — | a chat's branch as a template: `{branchPrefix}`, `{chatId8}`, `{chatId}`, `{project}`; unset = `{branchPrefix}{chatId8}` |
| `worktreePath` | string | `auto` | where a chat's worktree goes, as a template: the branch tokens plus `{repo}`, `{repoName}`, `{repoParent}`, `{branch}`, `{branchSlug}`; `auto` = `suggestWorktreePath` |
| `reuseExisting` | boolean | `true` | a session folder other than the project's own that is already a linked worktree is used as it is |
| `worktreeNotice` | string | the default notice | what the agent is told about its worktree: `{path}`, `{branch}`; blank = nothing |
| `base` | string | — | the start point of a new chat branch; the checkout's HEAD when empty |
| `instructions` | string | `''` | how to work in this repo |

## The worktree rule

Agentic imposes no worktree convention: every project names and places its chat worktrees its own way (#619, tracking #616), and the defaults keep the original behaviour.

- **Branch:** `branchTemplate` expanded (`chatWorktreeFor`), else `branchPrefix + short chat id` (the last 8 characters after `chat_`, lowercased; `gitBranchFor`). Either way it is checked against a conservative subset of git's ref-name rules (`isValidBranchName`).
- **Folder:** `worktreePath` expanded, normalised for the folder's OS (`/` is fine in a template on Windows, `..` resolves), else `suggestWorktreePath(cwd, branch)` from `@agentic/core`: beside a checkout named `main` under `branches/`, a sibling of a worktree already under `branches/`, else `<repo>-worktrees/<slug>`.
- Every token is deterministic for a chat, so every task and every environment of it lands in the same folder. An unknown token, an unbalanced brace, an invalid branch or a relative folder throws before any daemon round trip. `gitSettingsErrors(settings)` names the same problems per key, for a settings form.

With `reuseExisting` (the default), a session folder that is not the project's own on that environment, and whose listing badge is a linked worktree (one the user picked for the chat or task, made in a terminal or anywhere else), is used as it is.

Otherwise the plugin sends `{ kind: 'worktree', repo: cwd, branch, path, base? }`. The daemon makes it idempotent (#618): a worktree already there is `reused`, a branch whose folder was removed is `recreated`. The session opens in the daemon's path.

Either way the agent gets the notice (`worktreeNotice`, default `DEFAULT_WORKTREE_NOTICE`): it is already isolated and should not create another worktree or leave the folder. So a repo guide written for terminal use ("create a worktree first") does not pull the agent out of the folder that Files and Changes watch.

Every daemon error throws `git worktree <code>: <message>`, and the router parks the task `waiting { kind: 'project-feature' }` with that message (EXE-12). The errors include `worktree-mismatch` (something else at the folder), `branch-exists` (the branch is checked out in another folder), `not-a-repo`, `outside-roots`, `timeout` and `unsupported`.

### Examples

| Convention | Settings |
|---|---|
| default | nothing: `chat/a1b2c3d4` in `<repo>-worktrees/chat-a1b2c3d4` (or `branches/` beside a `main` checkout) |
| in-repo `.worktrees/` | `worktreePath: "{repo}/.worktrees/{branchSlug}"` |
| sibling folders | `worktreePath: "{repoParent}/{repoName}-{branchSlug}"` |
| `main/` + `branches/`, branch = folder | `branchTemplate: "chat-{chatId8}"`, `worktreePath: "{repoParent}/branches/{branchSlug}"` |

Out of scope here: push/pull, PR creation, clone. Creating worktrees with the project's own command and setup commands (#620) and cleanup (#623) are follow-ups.

## Layout

| File | What |
|---|---|
| `src/index.ts` | `gitFeaturePlugin`, `gitFeatureManifest`, `gitProjectSettings`, `GIT_FEATURE_ID`, `gitBranchFor`, `chatWorktreeFor`, `gitSettingsErrors`, `DEFAULT_WORKTREE_NOTICE`, `isValidBranchName`, `hostOsOfPath`, `identityOf` |
| `src/templates.ts` | the `{token}` templates: `expandTemplate`, `templateError`, `templateTokens`, `slugOf`, the token lists |
| `__tests__/git.test.ts` | the manifest, detect / identity / instructions, and `beforeSession` against a recording fake daemon |

The router end to end (two machines, reuse, parking) is covered in `packages/platform/__tests__/routing/projects.test.ts`.
