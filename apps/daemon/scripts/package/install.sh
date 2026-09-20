#!/bin/sh
# Installs agentic-daemon from this folder (macOS / Linux): checks Node, pairs the machine (optional),
# runs doctor, registers the background service for the current user.
#
# Run from the unpacked zip. Nothing is downloaded: the folder holds the daemon and every dependency.
# Node.js 22.12 or newer must be on PATH (https://nodejs.org), or passed with --node.
#
# Pairing needs a code from the platform (Machines > Pair a machine). Pass it with --code and the
# platform URL with --url, or pair first by hand: node bin/agentic-daemon.mjs pair <code> --url <url>.
#
# The daemon runs as a launchd agent (macOS) or a systemd user unit (Linux), never as root: the
# machine token and every Claude Code profile belong to the signed-in user.
#
# Usage: sh install.sh [--url <platform origin> --code <pairing code>] [--name <machine name>]
#                      [--node <path to node>] [--no-service] [--service-name <name>]
#   sh install.sh --url https://agentic.example --code ABC234
#   sh install.sh                                   # already paired: doctor + service only
set -eu

fail() { echo "$*" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
bin="$here/bin/agentic-daemon.mjs"
[ -f "$bin" ] || fail "bin/agentic-daemon.mjs not found next to install.sh - run this script from the unpacked zip."

url=""; code=""; name=""; node=""; no_service=""; service_name=agentic-daemon
while [ $# -gt 0 ]; do
    case "$1" in
        --url) url=$2; shift 2 ;;
        --code) code=$2; shift 2 ;;
        --name) name=$2; shift 2 ;;
        --node) node=$2; shift 2 ;;
        --no-service) no_service=1; shift ;;
        --service-name) service_name=$2; shift 2 ;;
        *) fail "install.sh: unknown argument $1" ;;
    esac
done

# 1. Node >= 22.12
[ -n "$node" ] || node=$(command -v node || true)
[ -n "$node" ] || fail "node is not on PATH. Install Node.js 22.12 or newer from https://nodejs.org, or run the one-line installer from the platform's Pair page (it downloads Node)."
node_version=$("$node" --version | sed 's/^v//')
node_major=${node_version%%.*}
node_minor=$(echo "$node_version" | cut -d. -f2)
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
    fail "Node.js $node_version is too old: agentic-daemon needs 22.12 or newer."
fi
echo "$("$node" "$bin" --version) on Node $node_version ($here)"

# 2. Pair (or check the machine is paired)
case "$(uname -s)" in
    Darwin) home=${AGENTIC_DAEMON_HOME:-"$HOME/Library/Application Support/agentic"} ;;
    *) home=${AGENTIC_DAEMON_HOME:-"${XDG_CONFIG_HOME:-$HOME/.config}/agentic"} ;;
esac
credentials="$home/credentials.json"
if [ -n "$code" ]; then
    [ -n "$url" ] || fail "--code needs --url <platform origin>."
    if [ -n "$name" ]; then "$node" "$bin" pair "$code" --url "$url" --name "$name"; else "$node" "$bin" pair "$code" --url "$url"; fi
elif [ ! -f "$credentials" ]; then
    fail "This machine is not paired ($credentials is missing). Get a code (README.md > Get a pairing code) and run again with --url <platform> --code <code>."
else
    echo "already paired ($credentials)"
fi

# 3. Doctor - environments.json, drivers, profiles. A failing check is reported, not fatal: fix it and re-run doctor.
"$node" "$bin" doctor || echo "warning: doctor found problems (see above). The daemon still starts; sessions on a failing environment are refused until it passes: node bin/agentic-daemon.mjs doctor" >&2

# 4. Background service
if [ -n "$no_service" ]; then
    echo "Skipping the background service (--no-service). Run in the foreground with: \"$node\" \"$bin\" run"
    exit 0
fi
sh "$here/scripts/install-service.sh" --node "$node" --bin "$bin" --name "$service_name"
echo ""
echo "Installed. The machine shows as online on the platform within a minute."
case "$(uname -s)" in
    Darwin)
        echo "  status:    launchctl print gui/\$(id -u)/$service_name | head"
        echo "  logs:      tail -f \"$home/logs/daemon.log\""
        ;;
    *)
        echo "  status:    systemctl --user status $service_name"
        echo "  logs:      tail -f \"${AGENTIC_DAEMON_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/agentic}/logs/daemon.log\""
        ;;
esac
echo "  uninstall: sh \"$here/uninstall.sh\""
