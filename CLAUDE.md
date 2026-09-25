# Claude Code guide (sigx standard)

@AGENTS.md

The imported `AGENTS.md` above is the canonical, tool-neutral guide — workflow,
build/test, packages, conventions, and the git-worktree flow all live there.
Below are only the Claude-Code-specific bits.

## Claude Code specifics

- **Branch first — never work on `main`.** Before touching any file, run
  `git branch --show-current`: a non-`main` branch under `<repo>/branches/`
  (a `pnpm wt` or agentic chat worktree) means you are already isolated — stay.
  Otherwise `pnpm wt new <N-short-slug>`, then continue from
  `<repo>/branches/<N-short-slug>` (`pnpm install` if `node_modules` is missing). Verify with `git branch --show-current`
  before every commit; if it prints `main` or nothing (detached HEAD), stop —
  move the changes
  (`git stash -u` → `pnpm wt new <N-short-slug>` →
  `cd <repo>/branches/<N-short-slug>` → `git stash pop`) instead of
  committing. See the warning at the top of `AGENTS.md`.
- **Worktrees**: Claude Code sessions are per-directory, so `pnpm wt new <name>`
  plus launching Claude Code from `<repo>/branches/<name>` gives a fully
  independent parallel session — no extra wiring needed.
- **The loop**: the `take-issue` skill (`.claude/skills/take-issue/`) runs
  AGENTS.md's development workflow for one issue — claim, worktree,
  `pnpm check`, `code-review`, one push, advisory Copilot, auto-merge. The
  `issue-wave` workflow (`.claude/workflows/issue-wave.js`) runs it for a list
  of issues in parallel.
