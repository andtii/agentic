# @agentic/daemon

`agentic-daemon` — the machine daemon (architecture §5b). It pairs a machine to a workspace once, keeps one reconnecting WebSocket to the platform, reports the machine's execution environments, serves runtime sessions over that socket and bridges platform tool calls. Node ≥ 22.12, Windows first; it also runs on Linux and macOS.

## Use

```sh
agentic-daemon pair <code> --url https://agentic.example [--name my-desktop]
agentic-daemon doctor
agentic-daemon run [--verbose]
```

- **pair** presents the 6-character code from the Machines page to `POST /auth/pair` and stores the machine token. Case, spaces and dashes in the code are ignored.
- **doctor** checks the pairing, `environments.json`, a driver per runtime, the working roots, and whatever each runtime driver checks (profile isolation, auth per profile — EXE-07). Exit 1 on any error. The token is never printed.
- **run** connects and serves until SIGINT / SIGTERM. Logs are JSON lines on stderr; `--verbose` adds debug lines.

### Files

| What | Windows | Linux | macOS |
|---|---|---|---|
| `credentials.json` (the token) | `%APPDATA%\agentic` | `$XDG_CONFIG_HOME/agentic` | `~/Library/Application Support/agentic` |
| `environments.json` | `%APPDATA%\agentic` | `$XDG_CONFIG_HOME/agentic` | same |
| session logs `{sessionId}.ndjson` | `%LOCALAPPDATA%\agentic\sessions` | `$XDG_STATE_HOME/agentic/sessions` | same |

`AGENTIC_DAEMON_HOME` puts all of them in one directory.

`credentials.json` is owner-only: `0600` on POSIX; on Windows inheritance is removed and only the current user is granted (`icacls`) before the token is written — if that fails, nothing is written.

### `environments.json`

```json
{
  "environments": [
    { "id": "env_work", "name": "Work", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-work", "cwdRoots": ["C:/src/work"], "concurrency": 2 },
    { "id": "env_personal", "name": "Personal", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-personal", "cwdRoots": ["C:/src/oss"] }
  ]
}
```

`profileDir` becomes the runtime's per-account config dir (`CLAUDE_CONFIG_DIR`) and never leaves the machine. `concurrency` defaults to 1. A session whose `cwd` is outside `cwdRoots`, or that would exceed `concurrency`, is refused with a reason.

### Run in the background (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1     # at logon, restarted on exit
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

This registers a per-user Scheduled Task, not a LocalSystem service: the token and each `CLAUDE_CONFIG_DIR` belong to the signed-in user. Output goes to `%LOCALAPPDATA%\agentic\logs\daemon.log`.

## How it works

- **Socket.** `wss://<platform>/_agentic/daemon/{machineId}` with `Authorization: Bearer <machine token>` (never in the URL). Redialled forever with exponential backoff and ±20 % jitter (0.5 s → 30 s); a refused token retries at the ceiling.
- **hello.** Environments via each driver's `inspect` (auth status, isolation, `CapabilityReport`), one report per runtime, and a resume cursor per live session. An environment whose runtime has no driver is left out and named by `doctor`.
- **Sessions.** `session.open` → the driver for the environment's runtime → `serveSession(session, { eventLog })` → `session.opened`. Session frames wait for `welcome`; `welcome.wanted` restarts each session's pump from the platform's cursor — from the in-memory buffer, then the NDJSON log, and a hole the log no longer covers is sent as a `gap` frame. A wanted session this daemon no longer runs (it restarted) is replayed from its log and reported `session.closed`.
- **Commands.** `session.command` → `ServedSession.handleCommand` (idempotent by `commandId`) → `session.reply`.
- **Platform tools.** A driver's `callTool(tool, input)` is sent as `tool.call` and settles on `tool.result` (an `error` rejects with `PlatformToolError`); calls still open across a reconnect are sent again after `welcome`; unanswered calls time out (10 min).
- **Logs.** Every line is redacted: the token, its secret part and anything shaped like a platform bearer token are replaced.
- **Drivers.** The daemon consumes only `RuntimeDriver` from `@agentic/core` and never branches on a runtime id. `src/drivers.ts` is the registration point; this build ships `claudeCodeDriver()` from `@agentic/runtimes/claude-code` (`"runtime": "claude-code"`), disposed when `run` stops.

## Test

```sh
pnpm test apps/daemon
```

`__tests__/conformance.test.ts` runs `daemonConformance` against this daemon over real WebSockets with an in-process relay; `__tests__/e2e.test.ts` pairs through the CLI, reports two environments, relays 100+ `mockAgent` frames, restarts the relay mid-turn and checks the replay is gapless and that no log line carries the token.
