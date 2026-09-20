# agentic-daemon

The machine daemon of the agentic platform. It pairs this machine to your workspace once, keeps one outbound WebSocket to the platform, reports the machine's execution environments (one per Claude Code account) and runs agent sessions on them. Nothing listens on this machine; the platform never holds an account credential.

This folder is self-contained: the daemon (`bin/`, `dist/`), every dependency (`node_modules/`, including the runtime CLIs the sessions run on) and the install scripts. Nothing is downloaded at install time.

Installing also writes the **`agentic-daemon` command** and puts it on your `PATH` for a new terminal, so every command below can be pasted as written. Where it went, and what to add by hand if the folder is not on `PATH`: `agentic-daemon launcher show`. From an unpacked zip before the install has run, the long form always works: `node bin/agentic-daemon.mjs <command>` (`node bin\agentic-daemon.mjs` on Windows).

## The short way

The platform's **Machines → Pair a machine** page prints one line per OS that does everything below for you — downloads this zip (and Node, when the machine has none), pairs with the code on the page and keeps the daemon running in the background. Paste it into a terminal and skip to "Environments". The rest of this file is the by-hand route and the reference.

## Prerequisites

- Signed in as the user who owns the Claude Code accounts (Windows 10/11, macOS or Linux with systemd).
- Node.js **22.12 or newer** on PATH — https://nodejs.org (LTS) — or pass its path to the installer (`-NodePath` / `--node`).
- A pairing code from the platform: **Machines → Pair a machine** (six characters, single use, valid 10 minutes).

## Install

1. Unpack the zip to a folder that stays put (the one-line installer uses `%LOCALAPPDATA%\agentic\daemon` / `~/.agentic/daemon`).
2. From the folder:

   ```powershell
   # Windows (PowerShell)
   powershell -ExecutionPolicy Bypass -File install.ps1 -Url https://<your platform> -Code <pairing code> [-Name <machine name>]
   ```
   ```sh
   # macOS / Linux
   sh install.sh --url https://<your platform> --code <pairing code> [--name <machine name>]
   ```

   This checks Node, writes the `agentic-daemon` command (`--no-path` / `-NoPath` writes it without touching any `PATH`), pairs (`credentials.json`, owner-only), runs `doctor`, and registers the background service: a **per-user Scheduled Task** on Windows, a **launchd agent** on macOS (`~/Library/LaunchAgents/agentic-daemon.plist`), a **systemd user unit** on Linux (`~/.config/systemd/user/agentic-daemon.service`) — each named `agentic-daemon`, started at login, restarted if it exits. Within a minute the machine is online on the platform's Machines page.

Already paired (upgrade, or you ran `pair` yourself)? Run the install script with no arguments.

## Environments

Add one environment per Claude Code account you want the platform to use — `agentic-daemon env add --name Work --root <folder>`, then `env login <id>` (see below). Before or after pairing: a daemon with no environments still connects, and a running daemon watches `environments.json` and reports a change within a second, no restart.

## Commands

```sh
agentic-daemon pair <code> --url https://<platform> [--name <machine name>]
agentic-daemon doctor      # pairing, environments.json, drivers, profile isolation, sign-in per profile
agentic-daemon env add --name <name> --root <dir> [--root <dir>…] [--concurrency <n>] [--account <label>] [--id <id>] [--profile-dir <dir>]
agentic-daemon env list
agentic-daemon env rm <id>         # the profile folder (the sign-in) stays on disk
agentic-daemon env login <id> [--claude <path to the claude CLI>]
agentic-daemon open [path]         # start a chat in this folder
agentic-daemon run         # foreground, logs on stderr (--verbose for debug lines)
agentic-daemon launcher show | install | remove   # the `agentic-daemon` command itself
agentic-daemon --version
```

(`command not found`? The install has not run, or it predates the launcher: use `node bin/agentic-daemon.mjs <command>` from this folder — `bin\agentic-daemon.mjs` on Windows — or re-run the install script.)

## Letting the web add environments (optional)

By default the platform cannot add, change or remove this machine's environments. To let the Machine page do it inside chosen folders only, allow them here, on the machine (never from the web):

```sh
agentic-daemon policy allow-root <folder>
agentic-daemon policy show
agentic-daemon policy off
```

(or `pair … --allow-root <folder>`). A running daemon picks the change up without a restart. The web can then only use folders inside the allowed ones: never a network share, never the daemon's own folder (which holds the token and the sign-ins), and a link or junction that leads out does not count as inside. New environments still need a sign-in on the machine: `env login <id>`.

## `environments.json`

`env add | rm` write it for you (atomically, owner-only); editing it by hand works too — a running daemon picks either up without a restart, and an edit that does not validate is logged and ignored (the running environments stay). `env add` gives each environment its own profile folder under the daemon's `profiles/` unless you pass `--profile-dir`, and refuses a folder another environment already uses.

```json
{
  "environments": [
    { "id": "env_work", "name": "Work", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-work", "cwdRoots": ["C:/src/work"], "concurrency": 2, "accountLabel": "me@work.example" },
    { "id": "env_personal", "name": "Personal", "runtime": "claude-code", "profileDir": "C:/Users/me/.claude-personal", "cwdRoots": ["C:/src/oss"] }
  ]
}
```

- `profileDir` is that account's Claude Code config dir (`CLAUDE_CONFIG_DIR`); every environment needs its own. Sign each one in once: `agentic-daemon env login env_work` — it runs `claude /login` with that profile and nothing inherited that could pick another account; without the `claude` CLI on `PATH`, add `--claude node_modules/@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude` (`claude.exe` on Windows). A running daemon re-checks environments that are not signed in every 30 s, so the platform shows the sign-in without a restart. Sessions always run on the copy in this folder.
- `cwdRoots`: the folders sessions may run in. A session outside them is refused.
- `concurrency` (default 1): sessions at once on that account.

`doctor` reports a shared config dir as an error, and a profile that is not signed in — or having no environments at all — as a warning; the same verdict is sent to the platform per environment.

## Files

| What | Windows | macOS | Linux |
|---|---|---|---|
| `credentials.json` — the machine token (owner-only) | `%APPDATA%\agentic` | `~/Library/Application Support/agentic` | `~/.config/agentic` |
| `environments.json`, `profiles/` | `%APPDATA%\agentic` | `~/Library/Application Support/agentic` | `~/.config/agentic` |
| session logs `{sessionId}.ndjson` | `%LOCALAPPDATA%\agentic\sessions` | `~/Library/Application Support/agentic/sessions` | `~/.local/state/agentic/sessions` |
| `daemon.log` (the service's stdout/stderr) | `%LOCALAPPDATA%\agentic\logs` | `~/Library/Application Support/agentic/logs` | `~/.local/state/agentic/logs` |

`AGENTIC_DAEMON_HOME=<dir>` (set for the user, before installing) puts credentials, environments and sessions in one directory; the service inherits it.

## Check, logs, restart

```powershell
# Windows
Get-ScheduledTask -TaskName agentic-daemon | Get-ScheduledTaskInfo      # LastRunTime, LastTaskResult
Get-Content -Wait "$env:LOCALAPPDATA\agentic\logs\daemon.log"
Stop-ScheduledTask -TaskName agentic-daemon; Start-ScheduledTask -TaskName agentic-daemon
```
```sh
# macOS
launchctl print gui/$(id -u)/agentic-daemon | head
tail -f ~/Library/Application\ Support/agentic/logs/daemon.log
launchctl kickstart -k gui/$(id -u)/agentic-daemon                      # restart
# Linux
systemctl --user status agentic-daemon
tail -f ~/.local/state/agentic/logs/daemon.log
systemctl --user restart agentic-daemon
```

Every log line is JSON; the token never appears in it.

## Upgrade

Re-run the one-line installer from the Pair page without a code (`AGENTIC_CODE` left out): it stops the service, replaces the folder and re-registers the service on the existing pairing. By hand: unpack the new zip to a new folder, run its install script with no arguments, delete the old folder.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1      # Windows
```
```sh
sh uninstall.sh                                             # macOS / Linux
```

Removes the service and the `agentic-daemon` command, and keeps the pairing, environments and logs (the folders above) — delete them by hand if wanted, and **revoke the machine on the platform** (its page's Revoke card) so its token stops working.

## Troubleshooting

- `agentic-daemon: command not found` — the install script writes it and puts it on `PATH`, but only for a **new** terminal; a daemon installed before that has none at all. Run `node bin/agentic-daemon.mjs …` from this folder, or re-run the install script. `agentic-daemon launcher show` (long form: `node bin/agentic-daemon.mjs launcher show`) says where it is and what to add to `PATH`.
- `not paired` — run the install script with `-Url … -Code …` / `--url … --code …`, or `agentic-daemon pair …`. A code is single use and expires after 10 minutes; mint a new one on the Pair page.
- `pairing failed: the code is not valid` — expired, used, or the URL is not the platform origin (no path, `https://`).
- The machine stays offline — `daemon.log` shows the dial and the refusal reason; a revoked token retries forever at the backoff ceiling (30 s): re-pair.
- `doctor` says `shared-config-dir` — two environments point at the same `profileDir`; give each account its own.
- `doctor` says `auth-missing` — sign that profile in (`env login <id>`).
- macOS: `launchctl bootstrap` says `Input/output error` — the agent is already loaded; `uninstall.sh` then install again.
