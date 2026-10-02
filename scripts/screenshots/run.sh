#!/bin/bash
# Regenerates docs/screenshots/*.png from made-up demo repositories, so no real data ends up in them.
# Needs Google Chrome; set CHROME to its binary if it isn't in the default macOS location.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/docs/screenshots"
DEMO="$(cd "$(mktemp -d)" && pwd -P)"  # real path: git reports /private/var, not /var
PORT=3099

bash "$HERE/build-demo.sh" "$DEMO"
(cd "$ROOT" && npm run build >/dev/null)

# A fake home folder makes every path in the app read "~/…".
env -u GIT_VIEWER_ROOTS -u GIT_VIEWER_CONFIG -u GIT_VIEWER_BACKUPS HOME="$DEMO/home" GIT_CONFIG_GLOBAL="$DEMO/gitconfig" PORT=$PORT \
  node "$ROOT/server/index.js" >"$DEMO/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$DEMO"' EXIT
sleep 1

APP="http://localhost:$PORT"
WT=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$DEMO/home/acme-api-rate-limits")
mkdir -p "$OUT"
node "$HERE/capture.mjs" "$APP/#/acme-api/worktrees" "$OUT/worktrees.png" 1400 1000 "document.querySelector('tr.expandable').click()"
node "$HERE/capture.mjs" "$APP/#/file?repo=acme-api&wt=$WT&group=unstaged&path=src%2Fratelimit%2Fbucket.ts" "$OUT/file-diff.png" 1100 600
node "$HERE/capture.mjs" "$APP/#/acme-api/remote" "$OUT/remote-branches.png" 1400 560
echo "Saved screenshots to $OUT"
