# @agentic/daemon

`agentic-daemon` — the machine daemon (architecture §5b). It pairs a machine to a workspace once, keeps one reconnecting WebSocket to the platform, reports the machine's execution environments, serves runtime sessions over that socket and bridges platform tool calls. Node ≥ 22.12, Windows first; it also runs on Linux and macOS.

## Use

```sh
agentic-daemon pair <code> --url https://agentic.example [--name my-desktop] [--allow-root C:\src]
agentic-daemon env add --name Work --root C:\src\work [--root …] [--concurrency 2] [--account me@work.example]
agentic-daemon env login env_work
agentic-daemon policy show | allow-root <dir> | deny-root <dir> | off
agentic-daemon doctor
agentic-daemon run [--verbose]
```

- **env add | list | rm | login** edit `environments.json` so nobody writes it by hand (`src/env-store.ts`, `src/env-cli.ts`). `add` takes `--name` and one or more `--root`, plus `--runtime` (default `claude-code`; it must be one this daemon has a driver for), `--id` (default `env_<name>`), `--concurrency`, `--account`, `--profile-dir`; with `--id <id> --replace` it changes an environment in place, keeping its profile. Each environment gets its own profile directory, `<config dir>/profiles/<id>`, and a directory another environment already uses is refused — two environments never share an account. The file is written atomically (temp + rename) and owner-only, like the credentials. `rm <id>` leaves the profile directory, which holds the sign-in. `login <id>` runs `claude /login` (or `--claude <path>`) with that profile as `CLAUDE_CONFIG_DIR` and the parent's `CLAUDE_CONFIG_DIR` / `ANTHROPIC_*` removed — the same rule sessions are opened under.
- **pair** presents the 6-character code from the Machines page to `POST /auth/pair` and stores the machine token. Case, spaces and dashes in the code are ignored. Each `--allow-root <dir>` (repeatable) lets the web add environments inside `<dir>` (below); every folder is checked before the code is spent.
- **policy show | allow-root | deny-root | off** edit `policy.json`, the machine-local policy for web-managed environments (#238, below). Only on the machine: nothing the platform sends can change it.
- **doctor** checks the pairing, `environments.json`, a driver per runtime, the working roots, and whatever each runtime driver checks (profile isolation, auth per profile — EXE-07). Exit 1 on any error; having no environments yet is a warning. The token is never printed.
- **run** connects and serves until SIGINT / SIGTERM. Logs are JSON lines on stderr; `--verbose` adds debug lines. A missing `environments.json` is zero environments — the machine connects and reports none. While running, the daemon watches the config directory: an `env add` / `env rm` or a hand edit is re-read once it settles (250 ms) and announced with an `env` frame, no restart; an edit that does not validate is logged and ignored, the running environments stay. Environments that are not signed in are inspected again every 30 s (`DaemonOptions.reinspectMs`), so a sign-in shows up on the platform by itself.
- **--version** (or `version`) prints `agentic-daemon <version>` (`DAEMON_VERSION`, what `hello.daemonVersion` reports) and exits 0 — the installer test and `install.ps1` use it.

### Files

| What | Windows | Linux | macOS |
|---|---|---|---|
| `credentials.json` (the token) | `%APPDATA%\agentic` | `$XDG_CONFIG_HOME/agentic` | `~/Library/Application Support/agentic` |
| `environments.json` | `%APPDATA%\agentic` | `$XDG_CONFIG_HOME/agentic` | same |
| `policy.json` (web-managed environments) | `%APPDATA%\agentic` | `$XDG_CONFIG_HOME/agentic` | same |
| session logs `{sessionId}.ndjson` | `%LOCALAPPDATA%\agentic\sessions` | `$XDG_STATE_HOME/agentic/sessions` | same |

`AGENTIC_DAEMON_HOME` puts all of them in one directory.

`credentials.json` is owner-only: `0600` on POSIX; on Windows inheritance is removed and only the current user is granted (`icacls`) before the token is written — if that fails, nothing is written.

### `environments.json`

What `env add` writes; the shape, for reading or a hand edit:

```json
{
  "environments": [
    { "id": "env_work", "name": "Work", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-work", "cwdRoots": ["C:/src/work"], "concurrency": 2 },
    { "id": "env_personal", "name": "Personal", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-personal", "cwdRoots": ["C:/src/oss"] }
  ]
}
```

`profileDir` becomes the runtime's per-account config dir (`CLAUDE_CONFIG_DIR`) and never leaves the machine. `concurrency` defaults to 1. A session whose `cwd` is outside `cwdRoots` (after symlinks are resolved), does not exist, or would exceed `concurrency`, is refused with a reason. `cwdRoots` are also the only folders the platform can browse (below).

### Environments from the web: `policy.json` (#238)

The platform can ask this machine to add, change or remove an environment (`env.request`, answered `env.response`; the Machine page, #239). The machine decides, under a policy its owner edits locally (decisions 2026-09-19 (c)):

```json
{ "webManaged": true, "allowedRoots": ["C:\\src"] }
```

- **Off by default.** No file, a file that does not parse, or no allowed root: every `env.request` is refused `policy-disabled`. `agentic-daemon policy allow-root <dir>` (or `pair --allow-root <dir>`) turns it on for `<dir>`; `deny-root` removes one, `off` forgets them all. `<dir>` must be an existing local folder outside the daemon's configuration and state folders; it is stored with links resolved, so it cannot later be re-pointed.
- **Only on the machine.** The file is written atomically and owner-only, like the credentials. No frame, flag or code path lets the platform write it (`src/env-manage.ts` cannot reach a policy writer, and a test holds it to that). A running daemon watches it and announces a change with an `env` frame; `hello` and `env` carry the policy (`policy`, with the roots only while it is on) so the web can explain a refusal.
- **Every working root is checked** (`checkWorkingRoot`, `src/policy.ts`): absolute; not a UNC share or a device path (`\\server\share`, `\\?\…`, `\\.\…`, `//…`), also after resolution (a mapped drive); inside an allowed root lexically, so `..` is judged by where it leads, and again after `realpath` of both sides, so a symlink or junction cannot lead out (the folder browser's `checkWithinRoots`) — another spelling of a folder inside (an 8.3 short name, a link to it) counts as that folder, and a folder outside is refused the same whether it exists or not; an existing folder; and overlapping none of the daemon's own folders in either direction: its configuration (the token, this policy, `profiles/`), its state (session logs) and every environment's profile. One bad root refuses the whole request (`outside-allowed-roots`); what is stored is the resolved root.
- **The machine chooses the profile.** A new environment gets `<config dir>/profiles/<id>`; a changed one keeps its own (also the runtime's default one, for a row written by hand) and keeps its `concurrency` and account label unless the request sets them. Nothing on the request can name a profile directory. The runtime must be one this daemon has a driver for, and an environment's runtime is never changed (its profile is signed in for that runtime).
- **Removing** refuses `in-use` while a session runs or opens on the environment and `unknown-environment` for one the machine does not have, and leaves the profile directory (the sign-in) on disk.
- The answer goes out after the `env` frame with the new descriptors. A failure that is the machine's own business (`environments.json` invalid, a write failed) is `io` with a message that names no local path; the details are in the daemon's log.
- Signing a new environment in stays local: `agentic-daemon env login <id>`.

### Installer zip (Windows)

```sh
pnpm build                                   # at the repo root: the zip is assembled from dist/ directories
pnpm --filter @agentic/daemon package        # → apps/daemon/release/agentic-daemon-<version>-<os>-<arch>.zip
```

`scripts/package.mjs` copies `bin/`, `dist/`, the production dependency closure into a plain `node_modules/` (workspace packages as their `dist/`; `@anthropic-ai/claude-agent-sdk` with the native CLI of the building platform; no declarations or source maps), the scheduled-task scripts and, at the zip root, `install.ps1`, `uninstall.ps1` and a README (`scripts/package/`). The zip needs only Node ≥ 22.12 on the target: `install.ps1 -Url <platform> -Code <pairing code>` checks Node, pairs, runs `doctor` and registers the task below. `scripts/lib/zip.mjs` is the dependency-free zip writer/reader; `__tests__/package.test.ts` builds the zip, unpacks it and runs `--version` and `doctor` on plain Node. Install, upgrade and uninstall steps: `docs/runbook.md` → "Daemon on a Windows machine".

### Run in the background (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1     # at logon, restarted on exit
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

This registers a per-user Scheduled Task, not a LocalSystem service: the token and each `CLAUDE_CONFIG_DIR` belong to the signed-in user. Output goes to `%LOCALAPPDATA%\agentic\logs\daemon.log`.

## How it works

- **Socket.** `wss://<platform>/_agentic/daemon/{machineId}` with `Authorization: Bearer <machine token>` (never in the URL). Redialled forever with exponential backoff and ±20 % jitter (0.5 s → 30 s); a refused token retries at the ceiling.
- **hello.** Environments via each driver's `inspect` (auth status, isolation, `CapabilityReport`) plus the per-environment verdict of the driver's `doctor` (`doctor: { ok, findings, checkedAt }` — the shared-config-dir and auth findings that name the environment, EXE-05/07; a driver whose checks throw gives every one of its environments an error verdict `driver-doctor-failed`, its message stripped of absolute paths by `withoutLocalPaths` — no local path reaches the platform, #274), one report per runtime, and a resume cursor per live session. `env` carries the same after a change. An environment whose runtime has no driver is left out and named by `doctor`.
- **Sessions.** `session.open` → the driver for the environment's runtime (with the session `Policy` compiled from `OpenSpec.policy` by `sessionPolicyOf`, #121 — the agent's approval rules, its tool grants and a delegated task's ancestors' constraints, the same compile the platform uses locally; no policy on the spec → the harness asks on its own terms) → `serveSession(session, { eventLog })` → `session.opened`. Session frames wait for `welcome`; `welcome.wanted` restarts each session's pump from the platform's cursor — from the in-memory buffer, then the NDJSON log, and a hole the log no longer covers is sent as a `gap` frame. A wanted session this daemon no longer runs (it restarted) is replayed from its log and reported `session.closed`.
- **Commands.** `session.command` → `ServedSession.handleCommand` (idempotent by `commandId`) → `session.reply`.
- **Folders (`fs.request`, #188).** The platform browses a machine's folders and adds git worktrees through `fs.request { requestId, environmentId, op }`, answered by `fs.response { requestId, result | error }` (`src/fs.ts`). A folder picker only — files are never listed or read.
  - `list { path }`: the immediate subfolders, sorted case-insensitively, without `.`-prefixed folders and `node_modules`, at most 500 (`truncated` beyond); `parent` unless the path is a root. Each folder carries a git badge read from files, never by running git: a `.git` directory is a `repo` (branch from `.git/HEAD`, or a short sha when detached), a `.git` file pointing into `…/worktrees/<name>` is a `worktree` (branch from that gitdir's `HEAD`).
  - `worktree { repo, branch, base?, path }`: `git -C <repo> worktree add -b <branch> -- <path> [base]` through `execFile` (no shell, 60 s timeout). `repo` must be a repo or worktree inside the roots; `path` must not exist and whatever of its parents exists must be inside the roots; the branch must pass `git check-ref-format --branch` and not exist yet.
  - **Safety.** Every path is checked lexically against the environment's `cwdRoots` first — `..` and relative paths are refused before the disk is touched — then again after `realpath` of the path and of every root, so a symlink or junction cannot lead out; every read then goes through the resolved path. A symlink in a listing counts only when it resolves to a folder inside a root. `session.open` runs the same check on its `cwd`. Refusals are named: `unknown-environment`, `outside-roots`, `not-found`, `not-a-repo`, `exists`, `branch-exists`, `invalid-branch`, `timeout`, `unsupported` (no git on PATH), `internal`. Each request is logged at debug level (`run --verbose`) with its op and path.
- **Platform tools.** A driver's `callTool(tool, input)` is sent as `tool.call` and settles on `tool.result` (an `error` rejects with `PlatformToolError`); calls still open across a reconnect are sent again after `welcome`; unanswered calls time out (10 min).
- **Logs.** Every line is redacted: the token, its secret part and anything shaped like a platform bearer token are replaced.
- **Drivers.** The daemon consumes only `RuntimeDriver` from `@agentic/core` and never branches on a runtime id. `src/drivers.ts` is the registration point; this build ships `claudeCodeDriver()` from `@agentic/runtimes/claude-code` (`"runtime": "claude-code"`), disposed when `run` stops.

## Test

```sh
pnpm test apps/daemon
```

`__tests__/fs.test.ts` runs `fs.request` against temp trees (junctions on Windows, symlinks elsewhere) and a real `git worktree add` when git is on PATH; `__tests__/conformance.test.ts` runs `daemonConformance` (the `fs` feature included) against this daemon over real WebSockets with an in-process relay; `__tests__/e2e.test.ts` pairs through the CLI, reports two environments, relays 100+ `mockAgent` frames, restarts the relay mid-turn and checks the replay is gapless and that no log line carries the token.
