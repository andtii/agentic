---
name: take-issue
description: Take one GitHub sub-issue of andtii/agentic from claim to auto-merge on the fast loop — claim, worktree, implement inside the issue's owner paths, pnpm check, local review, ONE push, advisory Copilot pass, auto-merge. Use when asked to "take", "do", "implement" or "pick up" issue #N, or to pick the next open issue of a tracking issue.
---

# take-issue — one issue, one push, auto-merge

The loop from `AGENTS.md` → "Development workflow", as steps. Every push costs a
CI run, so everything that can be caught locally is caught before the push.
Arguments: an issue number (`#123`), or a tracking issue to pick the next open,
unclaimed, unblocked sub-issue from.

## 0. Preconditions

```sh
gh issue list --label main-red --state open     # non-empty → main is broken: fix it first, or stop and report
gh issue view <N> --json title,body,labels,comments,state
```

- Stop and report if the issue is closed, labelled `in-progress` by someone
  else, labelled `blocked`, or any issue under **Depends on** is still open
  (`gh issue view <dep> --json state`).
- Claim it: `gh issue comment <N> --body "taking this"` and
  `gh issue edit <N> --add-label in-progress`.

## 1. Worktree

`git branch --show-current` — already on a non-`main` branch under
`<repo>/branches/`? Stay. Otherwise, from `<repo>/main`:

```sh
git -C <repo>/main fetch -q
pnpm wt new <N>-<short-slug>          # then work only in <repo>/branches/<N>-<short-slug>
git rebase origin/main                # the worktree starts from local main, which may lag
```

## 2. Read, then implement

1. The issue body — it is complete by design; skip the tracking thread.
2. Its **Read first** list: the `docs/design/...` board(s), the HANDOFF.md
   lines, the `docs/architecture.md` section, the requirement IDs.
3. Implement **only inside the issue's Owner paths**, plus your own placeholder
   in `docs/architecture.md` and your own `docs/promotion.md` line (edit the
   placeholder in place — never append, that is what collides). A change needed
   elsewhere → stop and file a follow-up issue; never edit another issue's paths.
4. Needs a `packages/core` type the contract lacks? That is a separate
   `contract` PR — say so and stop rather than adding it here.
5. Bug fix → failing test first. New behaviour → new tests, in new test files.
6. Pages build against the mock fixtures (`pnpm dev:mock`) when platform data is
   not there yet.

## 3. Gate locally

```sh
git fetch -q && pnpm check            # add --workers when you touched platform/web actor code
```

Then review the diff before it leaves the machine: run the `code-review` skill
(low effort) on the working tree. Fix every correctness finding, re-run
`pnpm check`. Style nits are not findings.

## 4. One push, PR, advisory Copilot

```sh
git add <paths>                       # never -A
git commit -m "<area>: <what>"        # no co-author trailers
git push -u origin HEAD
gh pr create --base main --title "<area>: <what>" --body "Closes #<N>. <summary + acceptance checklist ticked>" --reviewer @copilot
```

- `'@copilot' not found` → `gh api --method POST repos/andtii/agentic/pulls/<pr>/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'`.
- Wait up to ~5 minutes for `copilot-pull-request-reviewer`
  (`gh pr view <pr> --json reviews -q '.reviews[].author.login'`), while CI runs.
  Read its comments (`gh api repos/andtii/agentic/pulls/<pr>/comments`).
- Fix **only** correctness bugs, security issues, contract/layering breaks and
  missing tests — all in **one** commit, one push. Leave nits. Do not
  re-request review. Threads do not block merge.

## 5. Auto-merge and clean up

```sh
gh pr merge <pr> --auto --squash --delete-branch \
  --subject "$(gh pr view <pr> --json title -q .title) (#<pr>)" \
  --body "$(gh pr view <pr> --json body -q .body)"
gh pr checks <pr> --watch             # gate red → read the failing lane, fix, push once more
```

- `mergeStateStatus` `DIRTY` → `git fetch && git rebase origin/main && git push --force-with-lease`.
- Once merged: `pnpm wt rm <N>-<short-slug>` (from `<repo>/main`) and
  `gh issue edit <N> --remove-label in-progress` if the issue is still open.

## Report

End with: issue, PR URL, merged or not (and why not), follow-up issues filed,
anything the next wave should know.
