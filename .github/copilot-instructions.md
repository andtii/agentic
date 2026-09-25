# Copilot code review — andtii/agentic

Reviews here are advisory and read by agents that push **one** follow-up commit
at most. Spend comments only where they change behaviour.

Comment on:
- correctness bugs (wrong logic, unhandled states, races, broken edge cases);
- security issues (auth/permission bypass, secrets, injection, unsafe paths);
- contract or layering breaks: a cross-package type outside `packages/core`,
  a `packages/*` import of the `sigx` umbrella or of `node:` modules outside
  the Node-only packages, an upward import (core ← daemon-protocol ← memory /
  learning ← runtimes ← platform ← apps);
- actor mutations that do not end in `ctx.save()` / `ctx.append()` within the
  turn (Workers evict without `onDeactivate`);
- new behaviour without a test.

Do not comment on style, naming, wording, formatting, comment density,
optional refactors or anything oxlint and TypeScript already check. If there is
nothing of the kinds above, say so in one line.
