#!/bin/sh
# agentic-daemon one-line installer for macOS and Linux. The platform serves this file at /install.sh;
# the Pair page prints the line to run, with this machine's pairing code:
#
#   curl -fsSL '<platform origin>/install.sh' | AGENTIC_URL=<platform origin> AGENTIC_CODE=<code> AGENTIC_NAME=<machine name> sh
#
# It needs nothing installed beyond curl, unzip and tar: Node.js 22.12+ on PATH is used when present,
# otherwise a portable Node is downloaded from nodejs.org into the install folder. Then it downloads
# the daemon zip (agentic-daemon-<os>-<arch>.zip from the daemon-latest GitHub release), unpacks it
# to ~/.agentic/daemon and runs the zip's install.sh: pair (when AGENTIC_CODE is set), doctor, and the
# background service that keeps the daemon running — a launchd agent on macOS, a systemd user unit
# on Linux.
#
# Re-run without AGENTIC_CODE to upgrade an already paired machine (the service is stopped, the folder
# replaced, the service re-registered). Environment overrides:
#   AGENTIC_DAEMON_ZIP   a local path or URL of the zip to install instead of the release
#   AGENTIC_INSTALL_DIR  the install root (default ~/.agentic)
#   AGENTIC_DAEMON_HOME  where the daemon keeps credentials, environments and sessions (see the README)
#
# Source: apps/web/public/install.sh in https://github.com/andtii/agentic (docs/runbook.md section 5).
set -eu

NODE_VERSION=22.22.0
RELEASE=https://github.com/andtii/agentic/releases/download/daemon-latest

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

# 2. The daemon zip: the release asset, or AGENTIC_DAEMON_ZIP.
asset="agentic-daemon-$os-$arch.zip"
zip="$downloads/$asset"
case "${AGENTIC_DAEMON_ZIP:-}" in
    '')
        step "downloading $RELEASE/$asset"
        curl -fL --progress-bar -o "$zip" "$RELEASE/$asset"
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
sh "$daemon_dir/install.sh" "$@"
