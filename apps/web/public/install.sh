#!/bin/sh
# agentic-daemon one-line installer for macOS and Linux. The platform serves this file at /install.sh;
# the Pair page prints the line to run, with this machine's pairing code:
#
#   curl -fsSL '<platform origin>/install.sh' | AGENTIC_URL=<platform origin> AGENTIC_CODE=<code> AGENTIC_NAME=<machine name> sh
#
# It needs nothing installed beyond curl, unzip and tar: Node.js 22.12+ on PATH is used when present,
# otherwise a portable Node is downloaded from nodejs.org into the install folder. Then it reads the
# release manifest of the channel (or pinned version) asked for, downloads this machine's daemon zip
# (agentic-daemon-<os>-<arch>.zip) from that GitHub release, checks its sha256, unpacks it
# to ~/.agentic/daemon and runs the zip's install.sh: pair (when AGENTIC_CODE is set), the runtime
# harnesses from the same release (~/.agentic/harnesses), doctor, and the background service that keeps
# the daemon running — a launchd agent on macOS, a systemd user unit on Linux.
#
# It also installs the `agentic-daemon` command itself (~/.agentic/bin/agentic-daemon, linked into a folder
# on your PATH or added to your shell profile), so the commands the Machine page prints can be pasted.
#
# Re-run without AGENTIC_CODE to upgrade an already paired machine (the service is stopped, the folder
# replaced, the service re-registered). Environment overrides:
#   AGENTIC_CHANNEL      the release channel: latest (the newest main build) or stable (the newest
#                        daemon-v<semver> release); default below
#   AGENTIC_VERSION      a pinned release instead of a channel: daemon-v<semver> (or just <semver>)
#   AGENTIC_DAEMON_ZIP   a local path or URL of the zip to install instead of the release (no manifest,
#                        no sha256 check)
#   AGENTIC_RELEASES     the GitHub releases URL the manifest is read from (default
#                        https://github.com/andtii/agentic/releases): a fork, or a test server
#   AGENTIC_HARNESSES    the runtime harnesses to install, comma-separated (default
#                        claude-code,copilot-cli,codex-cli); none installs none
#   AGENTIC_INSTALL_DIR  the install root (default ~/.agentic)
#   AGENTIC_DAEMON_HOME  where the daemon keeps credentials, environments and sessions (see the README)
#   AGENTIC_NO_PATH      set to 1 to write the `agentic-daemon` command without touching any PATH
#
# Source: apps/web/public/install.sh in https://github.com/andtii/agentic (docs/runbook.md section 5).
set -eu

# The channel installed when neither AGENTIC_CHANNEL nor AGENTIC_VERSION is set. `latest` until the first
# stable daemon release exists, then `stable`.
DEFAULT_CHANNEL=latest
NODE_VERSION=22.22.0
RELEASES=${AGENTIC_RELEASES:-https://github.com/andtii/agentic/releases}

step() { printf '==> %s\n' "$*"; }
fail() { printf 'error: agentic install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "unsupported OS $(uname -s) (Windows: run the PowerShell line from the Pair page)" ;;
esac
case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail "unsupported CPU $(uname -m)" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v unzip >/dev/null 2>&1 || fail "unzip is required (Linux: apt install unzip / dnf install unzip)"
command -v tar >/dev/null 2>&1 || fail "tar is required"
[ -z "${AGENTIC_CODE:-}" ] || [ -n "${AGENTIC_URL:-}" ] || fail "AGENTIC_CODE needs AGENTIC_URL (the platform origin)"

root=${AGENTIC_INSTALL_DIR:-"$HOME/.agentic"}
daemon_dir="$root/daemon"
downloads="$root/downloads"
mkdir -p "$downloads"

# 1. Node >= 22.12: on PATH, already downloaded, or downloaded now.
node_ok() {
    v=$("$1" --version 2>/dev/null | sed 's/^v//') || return 1
    major=${v%%.*}
    minor=$(echo "$v" | cut -d. -f2)
    [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; }
}
node=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then node=$(command -v node); fi
portable="$root/node/bin/node"
if [ -z "$node" ] && [ -x "$portable" ] && node_ok "$portable"; then node=$portable; fi
if [ -z "$node" ]; then
    step "downloading Node.js $NODE_VERSION (no Node 22.12+ on PATH)"
    tarball="$downloads/node-v$NODE_VERSION-$os-$arch.tar.gz"
    curl -fL --progress-bar -o "$tarball" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$os-$arch.tar.gz"
    rm -rf "$root/node.new" && mkdir -p "$root/node.new"
    tar -xzf "$tarball" -C "$root/node.new" --strip-components=1
    rm -rf "$root/node" && mv "$root/node.new" "$root/node"
    rm -f "$tarball"
    node=$portable
fi
echo "node: $node ($("$node" --version))"

# 2. The daemon zip: this machine's asset in the release manifest, checked against its sha256 - or AGENTIC_DAEMON_ZIP.
asset="agentic-daemon-$os-$arch.zip"
zip="$downloads/$asset"
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    else "$node" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
    fi
}
case "${AGENTIC_DAEMON_ZIP:-}" in
    '')
        if [ -n "${AGENTIC_VERSION:-}" ]; then
            tag=daemon-v${AGENTIC_VERSION#daemon-v}
            manifest_url="$RELEASES/download/$tag/manifest.json"
        else
            channel=${AGENTIC_CHANNEL:-$DEFAULT_CHANNEL}
            case "$channel" in
                latest) manifest_url="$RELEASES/download/daemon-latest/manifest.json" ;;
                stable) manifest_url="$RELEASES/download/daemon-stable/manifest.json" ;;
                *) fail "unknown AGENTIC_CHANNEL $channel (latest or stable)" ;;
            esac
        fi
        step "reading $manifest_url"
        manifest="$downloads/manifest.json"
        curl -fsSL -o "$manifest" "$manifest_url" || fail "no release manifest at $manifest_url"
        # url, sha256 and version of this machine's asset, one per line.
        picked=$("$node" -e '
            const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            const a = m.assets && m.assets[process.argv[2]];
            if (!a) { console.error("the release has no daemon for " + process.argv[2]); process.exit(1); }
            console.log(a.url); console.log(String(a.sha256).toLowerCase()); console.log(a.version || m.version);
        ' "$manifest" "$os-$arch") || fail "cannot install from $manifest_url"
        rm -f "$manifest"
        url=$(echo "$picked" | sed -n 1p)
        expected=$(echo "$picked" | sed -n 2p)
        step "downloading agentic-daemon $(echo "$picked" | sed -n 3p): $url"
        curl -fL --progress-bar -o "$zip" "$url"
        actual=$(sha256_of "$zip")
        if [ "$actual" != "$expected" ]; then
            rm -f "$zip"
            fail "sha256 mismatch for $url
  expected $expected (the release manifest)
  actual   $actual (the download)"
        fi
        echo "sha256: $actual (matches the manifest)"
        ;;
    http://*|https://*)
        step "downloading $AGENTIC_DAEMON_ZIP"
        curl -fL --progress-bar -o "$zip" "$AGENTIC_DAEMON_ZIP"
        ;;
    *)
        [ -f "$AGENTIC_DAEMON_ZIP" ] || fail "AGENTIC_DAEMON_ZIP not found: $AGENTIC_DAEMON_ZIP"
        zip=$AGENTIC_DAEMON_ZIP
        step "installing $zip"
        ;;
esac

# 3. Stop a running daemon (its files are about to be replaced), unpack, swap the folder in.
if [ "$os" = darwin ]; then
    launchctl bootout "gui/$(id -u)/agentic-daemon" 2>/dev/null && step "stopped the running daemon" || true
elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop agentic-daemon.service 2>/dev/null && step "stopped the running daemon" || true
fi
step "unpacking to $daemon_dir"
rm -rf "$root/daemon.new"
unzip -q "$zip" -d "$root/daemon.new"
[ -f "$root/daemon.new/install.sh" ] || fail "$zip is not a daemon zip (no install.sh at its root)"
rm -rf "$daemon_dir"
mv "$root/daemon.new" "$daemon_dir"
case "$zip" in "$downloads"/*) rm -f "$zip" ;; esac

# 4. The zip's own installer: pair, doctor, background service.
step "installing"
set -- --node "$node"
[ -z "${AGENTIC_CODE:-}" ] || set -- "$@" --url "$AGENTIC_URL" --code "$AGENTIC_CODE"
[ -z "${AGENTIC_NAME:-}" ] || set -- "$@" --name "$AGENTIC_NAME"
[ -z "${AGENTIC_NO_PATH:-}" ] || set -- "$@" --no-path
# The harnesses come from the manifest the daemon came from (with AGENTIC_DAEMON_ZIP: the daemon's own release).
set -- "$@" --harness "${AGENTIC_HARNESSES:-claude-code,copilot-cli,codex-cli}"
[ -z "${manifest_url:-}" ] || set -- "$@" --manifest "$manifest_url"
sh "$daemon_dir/install.sh" "$@"
