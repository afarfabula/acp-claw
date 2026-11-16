#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_CHROME_HOME="${SERVER_CHROME_HOME:-/home_ext/quyanyi/server-chrome}"
# shellcheck disable=SC1091
source "$SERVER_CHROME_HOME/config.env"

export DISPLAY=":$DISPLAY_NUMBER"
export HOME="/home_ext/quyanyi"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1022}"

PROFILE_DIR="$SERVER_CHROME_HOME/profile"
STATE_DIR="$SERVER_CHROME_HOME/state"
VNC_SOCKET="$STATE_DIR/vnc.sock"
X11VNC_BIN="$SERVER_CHROME_HOME/vendor/bin/x11vnc"
NOVNC_WEB="$SERVER_CHROME_HOME/vendor/noVNC"
WEBSOCKIFY_BIN="$SERVER_CHROME_HOME/venv/bin/websockify"
