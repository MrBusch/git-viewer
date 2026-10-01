#!/bin/bash

PID_FILE="/tmp/git_viewer.pid"
PORT="${PORT:-3024}"

# macOS notifications when available; plain output elsewhere.
notify() { command -v osascript &>/dev/null && osascript -e "display notification \"$1\" with title \"Git Viewer\"" || echo "Git Viewer: $1"; }

PID=$(lsof -ti:$PORT 2>/dev/null)
rm -f "$PID_FILE"
if [ -n "$PID" ]; then
  kill $PID
  notify "Server stopped."
else
  notify "Server was not running."
fi
