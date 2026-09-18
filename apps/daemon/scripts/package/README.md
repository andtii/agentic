# agentic-daemon

The machine daemon of the agentic platform. It pairs this machine to your workspace once, keeps one outbound WebSocket to the platform, reports the machine's execution environments (one per Claude Code account) and runs agent sessions on them. Nothing listens on this machine; the platform never holds an account credential.

This folder is self-contained: the daemon (`bin/`, `dist/`), every dependency (`node_modules/`, including the Claude Code CLI the sessions run on) and the install scripts. Nothing is downloaded at install time.

## Prerequisites

- Windows 10/11, signed in as the user who owns the Claude Code accounts.
- Node.js **22.12 or newer** on PATH — https://nodejs.org (LTS).
- A pairing code from the platform (six characters, single use, valid 10 minutes) — see "Get a pairing code" below.

## Get a pairing code

The Machines page's **Pair machine** button is not wired to the platform yet. Until it is, mint the code from your browser's developer console while signed in to the platform (same origin, so the session cookie rides along):

```js
const { principal } = await (await fetch('/auth/me')).json();
const r = await fetch('/_sigx/actor/Workspace/registerMachinePending', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ args: [`ws:${principal.workspaceId}`, { name: 'my-desktop' }] })
});
console.log(await r.json());   // { machineId, pairingCode, expiresAt }
```

`pairingCode` is what `install.ps1 -Code` takes. A code is single use and expires after 10 minutes; run the call again for a new one.

## Install

1. Unpack the zip to a folder that stays put, e.g. `C:\agentic\daemon`.
2. Create `%APPDATA%\agentic\environments.json` (see below) — one entry per Claude Code account you want the platform to use. You can do this after pairing; the daemon reports changes without a restart.
3. From the folder, in PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1 -Url https://<your platform> -Code <pairing code>
   ```

   This checks Node, pairs (`credentials.json`, owner-only), runs `doctor`, and registers a **per-user Scheduled Task** named `agentic-daemon` that starts at logon and restarts if it exits. Within a minute the machine is online on the platform (`Machine.get()`, or `machines_list` on the MCP surface — the Machines page still shows sample data).

Already paired (upgrade, or you ran `pair` yourself)? Run `install.ps1` with no arguments.

## Commands

```powershell
node bin\agentic-daemon.mjs pair <code> --url https://<platform> [--name <machine name>]
node bin\agentic-daemon.mjs doctor      # pairing, environments.json, drivers, profile isolation, sign-in per profile
node bin\agentic-daemon.mjs run         # foreground, logs on stderr (--verbose for debug lines)
node bin\agentic-daemon.mjs --version
```

## `environments.json`

`%APPDATA%\agentic\environments.json`:

```json
{
  "environments": [
    { "id": "env_work", "name": "Work", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-work", "cwdRoots": ["C:/src/work"], "concurrency": 2, "accountLabel": "me@work.example" },
    { "id": "env_personal", "name": "Personal", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-personal", "cwdRoots": ["C:/src/oss"] }
  ]
}
```

- `profileDir` is that account's Claude Code config dir (`CLAUDE_CONFIG_DIR`); every environment needs its own. Sign each one in once: `$env:CLAUDE_CONFIG_DIR = "C:/Users/me/.claude-work"; claude /login` — with the `claude` CLI if you have it, or the copy in this folder: `node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe /login`. Sessions always run on the copy in this folder.
- `cwdRoots`: the folders sessions may run in. A session outside them is refused.
- `concurrency` (default 1): sessions at once on that account.

`doctor` reports a shared config dir as an error and a profile that is not signed in as a warning; the same verdict is sent to the platform per environment (`Machine.doctor()`).

## Files

| What | Where |
|---|---|
| `credentials.json` — the machine token (owner-only ACL) | `%APPDATA%\agentic` |
| `environments.json` | `%APPDATA%\agentic` |
| session logs `{sessionId}.ndjson` | `%LOCALAPPDATA%\agentic\sessions` |
| `daemon.log` (the task's stdout/stderr) | `%LOCALAPPDATA%\agentic\logs` |

`AGENTIC_DAEMON_HOME=<dir>` (set for the user, before installing) puts credentials, environments and sessions in one directory.

## Check, logs, restart

```powershell
Get-ScheduledTask -TaskName agentic-daemon | Get-ScheduledTaskInfo      # LastRunTime, LastTaskResult
Get-Content -Wait "$env:LOCALAPPDATA\agentic\logs\daemon.log"           # follow the log
Stop-ScheduledTask -TaskName agentic-daemon; Start-ScheduledTask -TaskName agentic-daemon
```

Every log line is JSON; the token never appears in it.

## Upgrade

1. Unpack the new zip to a new folder (or over this one after `uninstall.ps1`).
2. Run its `install.ps1` with no arguments: the pairing is reused, the task is re-registered to the new folder and restarted.
3. Delete the old folder.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

Removes the task and keeps the pairing, environments and logs (`%APPDATA%\agentic`, `%LOCALAPPDATA%\agentic`) — delete them by hand if wanted, and **revoke the machine on the platform** so its token stops working — from the browser console as in "Get a pairing code": `POST /_sigx/actor/machine/revoke` with `{ args: ['<workspaceId>:machine:<machineId>'] }` (the Machines page's Revoke is not wired yet).

## Troubleshooting

- `not paired` — run `install.ps1 -Url … -Code …` or `node bin\agentic-daemon.mjs pair …`. A code is single use and expires after 10 minutes; mint a new one ("Get a pairing code").
- `pairing failed: the code is not valid` — expired, used, or the URL is not the platform origin (no path, `https://`).
- The machine stays offline — `daemon.log` shows the dial and the refusal reason; a revoked token retries forever at the backoff ceiling (30 s): re-pair.
- `doctor` says `shared-config-dir` — two environments point at the same `profileDir`; give each account its own.
- `doctor` says `auth-missing` — sign that profile in (`$env:CLAUDE_CONFIG_DIR = "<profileDir>"; claude /login`).
