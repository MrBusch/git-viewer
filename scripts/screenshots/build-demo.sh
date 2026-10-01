#!/bin/bash
# Builds a fake home folder with made-up repositories for the README screenshots.
# Usage: build-demo.sh <empty folder>. Every repository, author, and commit in it is invented.
set -e
T="$1"; rm -rf "$T"; mkdir -p "$T/home" "$T/remotes"
H="$T/home"
export GIT_CONFIG_GLOBAL="$T/gitconfig"
git config --global user.name "Sam Lee"; git config --global user.email "sam@example.com"
git config --global init.defaultBranch main; git config --global advice.detachedHead false
NOW=$(date +%s)
c() { # c <hours-ago> <author> <message>
  local when=$((NOW - $1 * 3600)); local name="$2"; shift 2
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$(echo $name | tr 'A-Z ' 'a-z.')@example.com" \
  GIT_AUTHOR_DATE="@$when" GIT_COMMITTER_DATE="@$when" git commit -q -m "$@"
}
w() { mkdir -p "$(dirname "$1")"; printf '%b' "$2" > "$1"; }

# ── acme-api: the star of the screenshots ──────────────────────────────
git init -q --bare "$T/remotes/acme-api.git"
git clone -q "$T/remotes/acme-api.git" "$H/acme-api" 2>/dev/null; cd "$H/acme-api"
w README.md "# Acme API\n"; w src/server.ts "import { app } from './app';\n\napp.listen(8080);\n"
w src/ratelimit/bucket.ts "export class TokenBucket {\n  constructor(private capacity: number, private refillPerSecond: number) {}\n\n  private tokens = this.capacity;\n  private last = Date.now();\n\n  take(): boolean {\n    this.refill();\n    if (this.tokens < 1) return false;\n    this.tokens -= 1;\n    return true;\n  }\n\n  private refill() {\n    const now = Date.now();\n    const elapsed = (now - this.last) / 1000;\n    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);\n    this.last = now;\n  }\n}\n"
w src/billing/invoice.ts "export function total(lines: { amount: number }[]) {\n  return lines.reduce((sum, l) => sum + l.amount, 0);\n}\n"
w src/search/index.ts "export function buildIndex(docs: string[]) {\n  return new Map(docs.map((d, i) => [d.toLowerCase(), i]));\n}\n"
git add -A; c 340 "Priya Shah" "chore: Set up the API project"
w src/billing/invoice.ts "export function total(lines: { amount: number }[]) {\n  return lines.reduce((sum, l) => sum + l.amount, 0);\n}\n\nexport const currency = 'USD';\n"; git add -A; c 200 "Jordan Kim" "feat: Add a currency to invoices (#412)"
git push -q origin main 2>/dev/null
git remote set-head origin main

mkwt() { # mkwt <folder> <branch>
  git worktree add -q "$H/$1" -b "$2"
}
# feature branches with commits, pushed
mkwt acme-api-billing-retry feat/billing-retry
( cd "$H/acme-api-billing-retry"
  w src/billing/retry.ts "export async function withRetry<T>(fn: () => Promise<T>, attempts = 3) {\n  for (let i = 1; ; i++) {\n    try { return await fn(); } catch (e) { if (i >= attempts) throw e; }\n  }\n}\n"; git add -A; c 30 "Sam Lee" "feat: Retry failed card charges"
  w src/billing/retry.test.ts "test('retries', () => {});\n"; git add -A; c 26 "Sam Lee" "test: Cover the retry limit"
  git push -q -u origin feat/billing-retry 2>/dev/null )
mkwt acme-api-rate-limits feat/rate-limits
( cd "$H/acme-api-rate-limits"
  w src/ratelimit/config.ts "export const limits = { default: 100 };\n"; git add -A; c 6 "Sam Lee" "feat: Add per-plan rate limit config"
  git push -q -u origin feat/rate-limits 2>/dev/null )
mkwt acme-api-search-index fix/search-index
( cd "$H/acme-api-search-index"
  w src/search/index.ts "export function buildIndex(docs: string[]) {\n  return new Map(docs.map((d, i) => [d.trim().toLowerCase(), i]));\n}\n"; git add -A; c 120 "Sam Lee" "fix: Trim documents before indexing"
  git push -q -u origin fix/search-index 2>/dev/null )
mkwt acme-api-onboarding feat/onboarding-emails
( cd "$H/acme-api-onboarding"
  w src/email/welcome.ts "export const subject = 'Welcome to Acme';\n"; git add -A; c 50 "Sam Lee" "feat: Send a welcome email"
  git push -q -u origin feat/onboarding-emails 2>/dev/null )

# squash-merge fix/search-index into main, delete its remote branch
git merge -q --squash fix/search-index >/dev/null; c 96 "Priya Shah" "fix: Trim documents before indexing (#431)"
git push -q origin main 2>/dev/null; git push -q origin --delete fix/search-index 2>/dev/null

# teammates' remote branches
other() { # other <branch> <hours> <author> <msg>
  git switch -q -c "$1" main; w "src/${1//\//_}.ts" "// $4\n"; git add -A; c "$2" "$3" "$4"; git push -q origin "$1" 2>/dev/null; git switch -q main; git branch -q -D "$1"
}
other jordan/webhooks-v2 3 "Jordan Kim" "feat: Sign webhook payloads"
other priya/audit-log 8 "Priya Shah" "feat: Record admin actions in the audit log"
other alex/pagination-cursors 20 "Alex Rivera" "refactor: Use cursors for list pagination"
other mei/openapi-3-1 44 "Mei Tanaka" "docs: Move the API spec to OpenAPI 3.1"
other jordan/flaky-search-test 70 "Jordan Kim" "test: Stabilise the search ranking test"
other alex/deps-oct 150 "Alex Rivera" "chore: Update dependencies"

# teammate pushes to main and to the onboarding branch → local is behind
TMP="$T/tmp-clone"; git clone -q "$T/remotes/acme-api.git" "$TMP" 2>/dev/null
( cd "$TMP"; w src/health.ts "export const health = () => ({ ok: true });\n"; git add -A; c 2 "Mei Tanaka" "feat: Add a health check endpoint (#437)"; git push -q 2>/dev/null
  git switch -q feat/onboarding-emails; w src/email/welcome.ts "export const subject = 'Welcome to Acme!';\nexport const from = 'hello@acme.test';\n"; git add -A; c 4 "Alex Rivera" "fix: Use the shared sender address"
  w src/email/welcome.test.ts "test('subject', () => {});\n"; git add -A; c 3 "Alex Rivera" "test: Cover the welcome email"; git push -q 2>/dev/null )
rm -rf "$TMP"
git fetch -q --all --prune

# uncommitted work in the rate-limits worktree
( cd "$H/acme-api-rate-limits"
  w src/ratelimit/bucket.ts "export class TokenBucket {\n  constructor(private capacity: number, private refillPerSecond: number) {}\n\n  private tokens = this.capacity;\n  private last = Date.now();\n\n  take(cost = 1): boolean {\n    this.refill();\n    if (this.tokens < cost) return false;\n    this.tokens -= cost;\n    return true;\n  }\n\n  remaining(): number {\n    this.refill();\n    return Math.floor(this.tokens);\n  }\n\n  private refill() {\n    const now = Date.now();\n    const elapsed = (now - this.last) / 1000;\n    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);\n    this.last = now;\n  }\n}\n"
  w src/ratelimit/config.ts "export const limits = { default: 100, pro: 1000, enterprise: 10000 };\n"; git add src/ratelimit/config.ts
  w src/ratelimit/middleware.ts "import { TokenBucket } from './bucket';\n\nexport function rateLimit(bucket: TokenBucket) {\n  return (req, res, next) => (bucket.take() ? next() : res.status(429).end());\n}\n" )

# ── other repositories ────────────────────────────────────────────────
simple() { # simple <name> <branch-in-main> <author>
  git init -q --bare "$T/remotes/$1.git"; git clone -q "$T/remotes/$1.git" "$H/$1" 2>/dev/null; cd "$H/$1"
  w README.md "# $1\n"; git add -A; c 400 "$3" "chore: Initial commit"; w CHANGELOG.md "## 1.0\n"; git add -A; c 30 "$3" "docs: Start a changelog"
  git push -q origin main 2>/dev/null; git remote set-head origin main
  if [ "$2" != main ]; then git switch -q -c "$2"; w notes.md "wip\n"; git add -A; c 5 "Sam Lee" "wip: $2"; git push -q -u origin "$2" 2>/dev/null; fi
  git fetch -q
}
simple acme-web feat/dark-mode "Alex Rivera"
simple data-pipelines main "Mei Tanaka"
simple design-system main "Jordan Kim"
simple infra-terraform main "Priya Shah"
echo "built $H"
