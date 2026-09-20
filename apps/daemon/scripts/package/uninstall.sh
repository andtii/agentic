#!/bin/sh
# Stops and removes the agentic-daemon background service (macOS / Linux). The pairing
# (credentials.json), environments.json and the session logs are kept; delete the agentic folder under
# ~/Library/Application Support (macOS) or ~/.config and ~/.local/state (Linux) by hand to remove them,
# and revoke the machine on the platform (Machine.revoke - README.md > Uninstall) so its token stops working.
#
# Usage: sh uninstall.sh [--service-name <name>]
set -eu

here=$(cd "$(dirname "$0")" && pwd)
service_name=agentic-daemon
while [ $# -gt 0 ]; do
    case "$1" in
        --service-name) service_name=$2; shift 2 ;;
        *) echo "uninstall.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done
sh "$here/scripts/uninstall-service.sh" --name "$service_name"

# The `agentic-daemon` command (#354): the launcher, its link and the PATH line the install added.
# Node is needed to run it; a machine that has none keeps the files (they point at a folder that is going).
node=${AGENTIC_NODE:-}
if [ -z "$node" ]; then node=$(command -v node || true); fi
if [ -z "$node" ] && [ -x "$HOME/.agentic/node/bin/node" ]; then node="$HOME/.agentic/node/bin/node"; fi
if [ -n "$node" ] && [ -f "$here/bin/agentic-daemon.mjs" ]; then
    "$node" "$here/bin/agentic-daemon.mjs" launcher remove || echo "note: could not remove the agentic-daemon command; delete ~/.agentic/bin/agentic-daemon by hand." >&2
else
    echo "note: no Node found, so the agentic-daemon command was left behind; delete ~/.agentic/bin/agentic-daemon by hand." >&2
fi
case "$(uname -s)" in
    Darwin) echo "Kept: ${AGENTIC_DAEMON_HOME:-$HOME/Library/Application Support/agentic} (pairing, environments, session logs, daemon.log)." ;;
    *) echo "Kept: ${AGENTIC_DAEMON_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/agentic} (pairing, environments) and ${AGENTIC_DAEMON_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/agentic} (session logs, daemon.log)." ;;
esac
echo "Revoke the machine on the platform (Machine.revoke, see README.md > Uninstall) if it will not be paired again."
