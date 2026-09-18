# Changelog

All notable changes to `@agentic/daemon` (Keep a Changelog, semver).

## [Unreleased]

### Changed

- `session.open` checks its `cwd` with the same realpath-aware root check (#188): a cwd that a symlink or junction leads out of the roots is refused as outside, and a missing cwd is refused with "cwd … does not exist". `withinRoots` moved to `src/fs.ts` (still exported from the package).
- `agentic-daemon pair` names a non-JSON answer (#180): the HTML document, a proxy page or an empty error now fails `not_json` with "the platform did not answer as JSON (HTTP <status>, <content-type>) — is the URL the agentic Worker and is pairing mounted?" instead of "the platform answered with an unexpected token".

### Added

- `fs.request` (#188): the daemon answers `fs.response` for `list` (the immediate subfolders inside an environment's `cwdRoots`, sorted case-insensitively, hidden folders and `node_modules` skipped, capped at `FS_LIST_MAX_ENTRIES` with `truncated`, `parent` unless the path is a root, git `repo` / `worktree` badges with the branch read from `.git` / `HEAD` files) and `worktree` (`git worktree add -b` through `execFile`, no shell, 60 s timeout; `branch-exists`, `invalid-branch`, `exists`, `not-a-repo`, `outside-roots`). Paths are checked lexically, then again after `realpath` of the path and the roots, so no `..`, symlink or junction escapes a root. `answerFsRequest`, `checkWithinRoots` and `gitInfo` are exported from `src/fs.ts`; the conformance harness declares the `fs` feature.
- `session.open` policy (#121): `OpenSpec.policy` is compiled with `sessionPolicyOf` (`@agentic/runtimes`) and handed to `driver.open(env, spec, { policy })`, so a Claude Code session asks the platform only what the agent's approval rules (and a delegated task's ancestors' constraints) say to ask; without one the driver opens with no policy, as before.
- Installer zip (#52): `pnpm --filter @agentic/daemon package` (`scripts/package.mjs`) assembles `release/agentic-daemon-<version>-<os>-<arch>.zip` — built daemon, production dependency closure as a plain `node_modules/` (workspace packages as `dist/`, the Claude Code SDK with this platform's native CLI, no `.d.ts` / `.map`), `install.ps1` (Node check, pair, doctor, scheduled task) / `uninstall.ps1` / README at the root, on a dependency-free zip writer and reader (`scripts/lib/zip.mjs`). `__tests__/package.test.ts` unpacks it and runs `--version` and `doctor` on plain Node. `agentic-daemon --version` / `version` prints `agentic-daemon <DAEMON_VERSION>`. `install-service.ps1` stops a running task of the same name before re-registering (upgrade) and honours `AGENTIC_DAEMON_HOME`.
- `hello` / `env` carry each environment's `doctor` verdict (#43): the daemon runs every driver's `doctor` over its environments at start and on every environment change and sends `environmentVerdict` per row, so the Machine actor stores auth status and the isolation verdict per environment (EXE-05/07); a driver whose checks throw yields an error verdict `driver-doctor-failed` for each of its environments.
- `agentic-daemon pair <code> --url`, `run`, `doctor` (#19). Pairing stores the machine token owner-only (`icacls` on Windows, `0600` elsewhere); `environments.json` is validated into `LocalEnvironment[]`; `doctor` merges its own checks with each runtime driver's.
- `createDaemon`: one reconnecting WebSocket (bearer header, backoff with jitter), `hello` with environments / capabilities / resume cursors, `welcome.wanted`-driven gapless replay with explicit `gap` frames, `serveSession` per session with idempotent commands, `tool.call` / `tool.result` bridge, cwd-root and concurrency refusals, heartbeats.
- `ndjsonEventLog`: per-session NDJSON `EventLogStore` under `%LOCALAPPDATA%/agentic/sessions`, keyed by the platform session id.
- `builtinDrivers()` registers the Claude Code driver (`@agentic/runtimes/claude-code`); `run` disposes drivers on stop.
- Redacting JSON logger; Windows scheduled-task install / uninstall scripts.
