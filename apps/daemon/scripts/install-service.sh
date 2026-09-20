#!/bin/sh
# Runs agentic-daemon in the background for the current user: at login, restarted when it exits.
#
# macOS: a launchd agent, ~/Library/LaunchAgents/agentic-daemon.plist (KeepAlive, RunAtLoad).
# Linux: a systemd user unit, ~/.config/systemd/user/agentic-daemon.service (Restart=always);
#        `loginctl enable-linger $USER` keeps it running when nobody is logged in.
# Never a system service: the machine token and every Claude Code profile belong to the user.
# Pair the machine first: `agentic-daemon pair <code> --url <platform>`.
#
# Usage: install-service.sh [--node <path>] [--bin <path to bin/agentic-daemon.mjs>] [--name <service name>]
set -eu

name=agentic-daemon
here=$(cd "$(dirname "$0")" && pwd)
bin="$here/../bin/agentic-daemon.mjs"
node=$(command -v node || true)
while [ $# -gt 0 ]; do
    case "$1" in
        --node) node=$2; shift 2 ;;
        --bin) bin=$2; shift 2 ;;
        --name) name=$2; shift 2 ;;
        *) echo "install-service.sh: unknown argument $1" >&2; exit 2 ;;
    esac
done
[ -n "$node" ] || { echo "install-service.sh: node not found; pass --node <path>" >&2; exit 1; }
bin=$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")

case "$(uname -s)" in
    Darwin)
        home=${AGENTIC_DAEMON_HOME:-"$HOME/Library/Application Support/agentic"}
        log_dir="$home/logs"
        ;;
    *)
        home=${AGENTIC_DAEMON_HOME:-"${XDG_CONFIG_HOME:-$HOME/.config}/agentic"}
        log_dir=${AGENTIC_DAEMON_HOME:-"${XDG_STATE_HOME:-$HOME/.local/state}/agentic"}/logs
        ;;
esac
[ -f "$home/credentials.json" ] || { echo "This machine is not paired ($home/credentials.json is missing). Run: agentic-daemon pair <code> --url <platform>" >&2; exit 1; }
mkdir -p "$log_dir"
log="$log_dir/daemon.log"
# The daemon's children (the Claude Code CLI, git) are found on this PATH — launchd and systemd start with a bare one.
path="$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# AGENTIC_DAEMON_HOME, when set for this install, is what the service sees too.
home_plist=""
home_unit=""
if [ -n "${AGENTIC_DAEMON_HOME:-}" ]; then
    home_plist="        <key>AGENTIC_DAEMON_HOME</key><string>$AGENTIC_DAEMON_HOME</string>"
    home_unit="Environment=AGENTIC_DAEMON_HOME=$AGENTIC_DAEMON_HOME"
fi

case "$(uname -s)" in
    Darwin)
        plist="$HOME/Library/LaunchAgents/$name.plist"
        mkdir -p "$HOME/Library/LaunchAgents"
        # Upgrade: unload the agent that may be running an older copy.
        launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
        cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$name</string>
    <key>ProgramArguments</key>
    <array><string>$node</string><string>$bin</string><string>run</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>60</integer>
    <key>StandardOutPath</key><string>$log</string>
    <key>StandardErrorPath</key><string>$log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$path</string>
        <key>HOME</key><string>$HOME</string>
$home_plist
    </dict>
</dict>
</plist>
EOF
        launchctl bootstrap "gui/$(id -u)" "$plist"
        echo "agentic-daemon registered as launchd agent '$name' ($plist) and started. Log: $log"
        ;;
    Linux)
        command -v systemctl >/dev/null 2>&1 || { echo "systemd is not available: run the daemon in the foreground with: \"$node\" \"$bin\" run" >&2; exit 1; }
        unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
        mkdir -p "$unit_dir"
        cat > "$unit_dir/$name.service" <<EOF
[Unit]
Description=agentic-daemon — the agentic machine daemon
After=network-online.target

[Service]
ExecStart="$node" "$bin" run
Restart=always
RestartSec=60
Environment=PATH=$path
$home_unit
StandardOutput=append:$log
StandardError=append:$log

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now "$name.service"
        systemctl --user restart "$name.service"
        loginctl enable-linger "$(id -un)" 2>/dev/null || true
        echo "agentic-daemon registered as systemd user unit '$name' and started. Log: $log"
        ;;
    *)
        echo "install-service.sh: unsupported OS $(uname -s); run the daemon in the foreground with: \"$node\" \"$bin\" run" >&2
        exit 1
        ;;
esac
