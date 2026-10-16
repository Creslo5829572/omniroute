#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: installs deps and brings up a local
# OmniRoute gateway so the agent can call any configured model via `ask-model`.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

DATA_DIR="${DATA_DIR:-$HOME/.omniroute}"
LOG="$DATA_DIR/claude-dev-server.log"
PORT="${PORT:-20128}"
mkdir -p "$DATA_DIR"

# 1. Dependencies (skipped when the cached container already has a matching tree).
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund
fi

# 2. .env with local-only secrets.
[ -f .env ] || cp .env.example .env
if grep -qE '^JWT_SECRET=$' .env; then
  sed -i "s|^JWT_SECRET=$|JWT_SECRET=$(openssl rand -hex 48)|" .env
fi
if grep -qE '^API_KEY_SECRET=$' .env; then
  sed -i "s|^API_KEY_SECRET=$|API_KEY_SECRET=$(openssl rand -hex 32)|" .env
fi

# 3. Start the gateway detached. NODE_USE_ENV_PROXY makes Node's fetch use the
#    container's egress proxy (the container has no DNS of its own).
if ! curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  NODE_USE_ENV_PROXY=1 nohup setsid npm run dev >"$LOG" 2>&1 </dev/null &
fi

# 4. Once healthy: create the gateway API key and import provider keys from env.
nohup setsid node .claude/hooks/omniroute-bootstrap.mjs >"$DATA_DIR/claude-bootstrap.log" 2>&1 </dev/null &

# 5. Session env: helper on PATH + gateway location.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$ROOT/.claude/hooks/bin:\$PATH\""
    echo "export OMNIROUTE_URL=\"http://127.0.0.1:$PORT\""
    echo "export OMNIROUTE_KEY_FILE=\"$DATA_DIR/claude-code.key\""
  } >>"$CLAUDE_ENV_FILE"
fi

echo "OmniRoute gateway starting on :$PORT (log: $LOG). Use: ask-model <model> \"prompt\""
