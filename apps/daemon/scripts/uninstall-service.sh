#!/bin/sh
# Stops and removes the agentic-daemon background service (launchd agent on macOS, systemd user
# unit on Linux). The pairing and the session logs are kept.
#
# Usage: uninstall-service.sh [--name <service name>]
set -eu

name=agentic-daemon
while [ $# -gt 0 ]; do
    case "$1" in
        --name) name=$2; shift 2 ;;
        *) echo "uninstall-service.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done

case "$(uname -s)" in
    Darwin)
        plist="$HOME/Library/LaunchAgents/$name.plist"
        if [ -f "$plist" ]; then
            launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
            rm -f "$plist"
            echo "Removed launchd agent '$name'."
        else
            echo "No launchd agent named '$name'."
        fi
        ;;
    Linux)
        unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$name.service"
        if [ -f "$unit" ]; then
            systemctl --user disable --now "$name.service" 2>/dev/null || true
            rm -f "$unit"
            systemctl --user daemon-reload 2>/dev/null || true
            echo "Removed systemd user unit '$name'."
        else
            echo "No systemd user unit named '$name'."
        fi
        ;;
    *)
        echo "uninstall-service.sh: unsupported OS $(uname -s)" >&2
        exit 1
        ;;
esac
