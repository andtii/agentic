# Self-hosting — your own node, reachable from your phone

One machine runs the whole platform — the actors in one SQLite file, the web app, the daemon socket and this machine's own daemon — as one Node process (`agentic start`, `apps/node`; architecture §3 "Hosts"). This page takes you from a clean machine to that node open on your phone. For the Cloudflare deployment instead, see [`runbook.md`](runbook.md) §2; for developing on the Node host, §4b there.

## 1. Install

You need Node ≥ 22.13 (for `node:sqlite`), pnpm 10 (`corepack enable`) and Git.

```sh
git clone https://github.com/andtii/agentic && cd agentic
pnpm install
pnpm --filter @agentic/node bundle     # the daemon, the packages, then the web app into apps/node/dist
```

To update later: `git pull && pnpm install && pnpm --filter @agentic/node bundle`, then restart the node (§2). There is no hot reload.

## 2. Start it and claim it

```sh
pnpm --filter @agentic/node start      # or: node apps/node/bin/agentic.mjs start
```

The first start:

1. creates the data folder (§3) and generates `SESSION_SECRET` and `WORKSPACE_KEK` into its `.env`;
2. serves the platform on `http://localhost:8787` (`--port <n>` or `PORT` to change it);
3. pairs **this machine** as the node's first runtime machine and runs its daemon in the same process (`--no-daemon` for the hub only);
4. prints — and opens in the browser (`--no-open` only prints it) — a **claim link**, `/auth/claim?t=…`, valid once, for 24 hours.

Open the claim link on this machine and choose a passphrase. You are now the node's owner (`local_owner`); later sign-ins are `/auth/local-login` with that passphrase (five wrong tries a minute and it answers 429). Then add your Anthropic key at `/plugins/anthropic-api`, or a Claude Code environment on this machine's page under **Machines**.

`agentic status` (`node apps/node/bin/agentic.mjs status`) says where the data is, whether the node is claimed and running, and which machine id this machine is paired as.

Stop with Ctrl+C (or SIGTERM): the daemon closes its sessions, the host finishes its turns and flushes, and the database closes. To keep the node up across logouts and reboots, run the same command under whatever supervises processes on your OS (a systemd user unit, a launchd agent, a Scheduled Task at logon).

## 3. Data and backup

Everything lives in `$AGENTIC_HOME`, default `~/.agentic` (`%USERPROFILE%\.agentic` on Windows):

| Path | What |
|---|---|
| `agentic.db` (+ `-wal`, `-shm`) | every actor's state |
| `files/` | chat attachments and exports |
| `.env` | the node's secrets and settings, mode 0600 |
| `daemon/` | this machine's daemon: pairing, environments, policy, sessions, its log |
| `owner.json`, `claim-token` | the local owner (passphrase hash); the claim link's token until it is used |
| `logs/` | reserved for the host's logs |

**`WORKSPACE_KEK` in `.env` seals every secret the node keeps** (API keys, connector tokens). It is never regenerated while it is there — lose it and those secrets are gone; a backup without `.env` restores a node whose keys all have to be entered again.

Back up in one of two ways:

- **Stopped:** stop the node, copy the whole folder (`agentic.db` together with any `-wal` / `-shm` beside it), start again.
- **Running:** take a consistent copy of the database with SQLite's online backup, then copy the rest of the folder:

  ```sh
  sqlite3 ~/.agentic/agentic.db ".backup '/backups/agentic.db'"
  ```

  Never copy `agentic.db` alone while the node runs — the newest writes may still be in `-wal`.

To restore, put the folder back (or point `AGENTIC_HOME` at it) and start. Moving from a Cloudflare deployment is `agentic export` / `agentic import` (`agentic --help`).

## 4. Settings

The node reads settings from the process environment first, then `<home>/.env` (`KEY=value` lines; restart to apply):

| Key | Default | What |
|---|---|---|
| `PORT` | `8787` | the one port for the app, the live sockets and the daemon socket |
| `APP_ORIGIN` | `http://localhost:PORT` | the address people use to reach the node — see §5 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | optional GitHub sign-in (§5.4) |
| `AGENTIC_DEV_LOGIN` | — | a one-click dev login; for development only, **never** on a node others can reach |

**Set `APP_ORIGIN` to the https address you open the node at** once you use one of the options below. It is the base of the GitHub OAuth callback, the MCP OAuth issuer and the A2A agent cards, the address `agentic start` prints its links with, and an origin the upload and connector routes accept — behind a proxy the node sees plain http, so without it a browser on the https address is refused (`cross-origin`) when it attaches a file. Signing in on `http://localhost:PORT` on the node's own machine keeps working either way.

## 5. Reach it from your phone

The node listens on every interface on its port, over plain http. On `localhost` or a LAN address that works — the sign-in cookies then travel as `agentic-*` without `Secure` — but a phone on the move needs a route in, and a password over plain http on a network you do not control is not one. Put https in front:

| Option | Who can reach it | `APP_ORIGIN` |
|---|---|---|
| **`tailscale serve`** (recommended) | only devices on your tailnet | `https://<machine>.<tailnet>.ts.net` |
| `tailscale funnel` | anyone on the internet | `https://<machine>.<tailnet>.ts.net` |
| `cloudflared tunnel` | anyone on the internet | `https://<random>.trycloudflare.com`, or your own hostname |

All three terminate TLS and forward to `localhost:PORT` with `X-Forwarded-Proto: https`, so the node sets its normal `__Host-*` `Secure` cookies; live updates and the daemon socket are WebSockets and pass through all three.

### 5.1 `tailscale serve` — private, recommended

Only your own devices can reach the node, and the certificate is a real one for your tailnet name.

1. Install Tailscale on the node's machine and sign in. In the admin console (login.tailscale.com → DNS) keep **MagicDNS** on and enable **HTTPS Certificates**.
2. Serve the node, in the background, across restarts:

   ```sh
   tailscale serve --bg --https=443 localhost:8787
   tailscale serve status        # prints https://<machine>.<tailnet>.ts.net
   ```

   (`tailscale serve --https=443 off` takes it down again.)
3. Put that address in `<home>/.env` and restart the node:

   ```ini
   APP_ORIGIN=https://<machine>.<tailnet>.ts.net
   ```

4. On the phone: install the Tailscale app, sign in to the same tailnet, open `https://<machine>.<tailnet>.ts.net`, and sign in with your passphrase ("Sign in with passphrase"). Add it to the home screen if you like.

### 5.2 `tailscale funnel` — public

The same address, open to the whole internet (the tailnet policy must allow funnel for the machine; the CLI offers to enable it):

```sh
tailscale funnel --bg --https=443 localhost:8787
```

`APP_ORIGIN` as in §5.1. Anyone can now load the sign-in page, so read §5.5 first.

### 5.3 `cloudflared tunnel` — public, no Tailscale

A quick tunnel needs no Cloudflare account, but its address is random and changes on every run:

```sh
cloudflared tunnel --url http://localhost:8787    # prints https://<random>.trycloudflare.com
```

Put the printed address in `APP_ORIGIN` and restart the node — each time the tunnel restarts. For a lasting address, use a named tunnel on a domain in your Cloudflare account:

```sh
cloudflared tunnel login
cloudflared tunnel create agentic
cloudflared tunnel route dns agentic agentic.example.com
cloudflared tunnel run --url http://localhost:8787 agentic
```

and `APP_ORIGIN=https://agentic.example.com`. Anyone can load the sign-in page: read §5.5.

### 5.4 GitHub sign-in (optional)

The passphrase is enough for one owner. To also sign in with GitHub, register an OAuth app (GitHub → Settings → Developer settings → OAuth Apps → New OAuth App) **per address**:

| Field | Value |
|---|---|
| Homepage URL | your `APP_ORIGIN` |
| Authorization callback URL | `${APP_ORIGIN}/auth/callback` — exactly, no trailing slash |

and put `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `.env`. GitHub sign-in only works on the address `APP_ORIGIN` names; a quick tunnel's new address means a callback URL edit at GitHub too. A GitHub sign-in is its own workspace (`gh_<id>`), not the local owner's — the machine `agentic start` paired and everything you set up after claiming belong to the passphrase owner.

### 5.5 Before you expose it publicly

- **Every GitHub user who can reach the node gets a workspace of their own** when GitHub sign-in is configured (there is no allow-list). On a public address, leave `GITHUB_CLIENT_ID` unset unless you want that.
- Never set `AGENTIC_DEV_LOGIN` on a node anyone else can reach.
- Pick a long passphrase: it is the one thing between the internet and agents that run code on your machine.
- Firewall the node's port (8787) from your LAN if you do not want it reachable there over plain http; the proxy reaches it on `localhost`.

## 6. Pair a second machine

The node's own machine is paired already. For another one (a laptop, a build box):

1. Make sure it can reach the node: for `tailscale serve`, join it to the tailnet too.
2. Open **Machines → Pair a machine** (`/pair`) **at the address the machine will use** — the page puts its own origin in the install line.
3. Paste the install line for its OS on that machine (runbook §5.3). It installs the daemon, pairs with the code, and registers the background service; within a minute the machine is online on **Machines**.

By hand, with the daemon already installed: `agentic-daemon pair <code> --url https://<machine>.<tailnet>.ts.net --name <name>`, then `agentic-daemon run` (or let the service run it). A machine on the node's LAN can use `http://<lan address>:8787` instead — the daemon socket accepts plain `ws://` — but that URL is what it keeps dialling, so prefer the address that works from everywhere the machine goes.

## 7. When something is off

- **Uploads fail with `cross-origin`, or GitHub says `redirect_uri` mismatch** — `APP_ORIGIN` is not the address in the browser's bar. Fix `.env`, restart.
- **Signed in on one address, signed out on another** — cookies belong to an address: `localhost`, the LAN address and the https one each sign in separately.
- **The claim link expired, or you lost it** — restart the node while it is unclaimed: it prints the link again (a fresh one once the old expired).
- **The phone cannot reach `*.ts.net`** — the Tailscale app is off or on another tailnet, or MagicDNS is off.
- **`agentic status`** says whether the node is serving at all.
