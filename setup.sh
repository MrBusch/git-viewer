#!/bin/bash
# Creates the "Git Viewer" macOS desktop launcher app.
# Run once: bash setup.sh

set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Desktop/Git Viewer.app"
TMP="$(mktemp /tmp/git_viewer_XXXX.applescript)"

cat > "$TMP" <<APPLESCRIPT
on run
  set projectDir to "$PROJECT"
  set isRunning to false
  try
    set r to do shell script "lsof -ti:3024"
    if r is not "" then set isRunning to true
  end try

  if isRunning then
    set choice to button returned of (display dialog "Git Viewer is running." buttons {"Stop Server", "Open App"} default button "Open App" with title "Git Viewer")
    if choice is "Open App" then
      do shell script "bash '" & projectDir & "/start.sh' >> /tmp/git_viewer.log 2>&1"
    else
      do shell script "bash '" & projectDir & "/stop.sh'"
    end if
  else
    do shell script "bash '" & projectDir & "/start.sh' >> /tmp/git_viewer.log 2>&1"
  end if
end run
APPLESCRIPT

osacompile -o "$APP" "$TMP"
rm "$TMP"

echo "✓ Git Viewer.app created on your Desktop."
echo "  Double-click it to start the server and open the app."
