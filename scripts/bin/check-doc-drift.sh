#!/bin/bash
# Detect documentation drift between implementation and docs.
# Exit 0 if no drift, exit 1 if drift detected.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRIFT=0

# --- 1. deployment-options.md vs environment-types.ts ---
TYPES_FILE="$ROOT/packages/cdk/config/environment-types.ts"
DEPLOY_DOC="$ROOT/docs/deployment-options.md"

if [[ -f "$TYPES_FILE" && -f "$DEPLOY_DOC" ]]; then
  props=$(sed -n '/^export interface EnvironmentConfig/,/^}/p' "$TYPES_FILE" \
    | grep -oE '^\s+(readonly\s+)?[a-zA-Z]+\??' \
    | sed 's/readonly //;s/?//;s/^ *//' \
    | grep -vE '^(env|hostName|domainName|username|email|password|s)$' \
    | sort -u)
  for prop in $props; do
    if ! grep -q "\`$prop\`" "$DEPLOY_DOC" 2>/dev/null; then
      echo "DRIFT: deployment-options.md missing option: $prop" >&2
      DRIFT=1
    fi
  done
fi

# --- 2. agent/README.md vs agent config/index.ts ---
AGENT_CONFIG="$ROOT/packages/agent/src/config/index.ts"
AGENT_DOC="$ROOT/packages/agent/README.md"

if [[ -f "$AGENT_CONFIG" && -f "$AGENT_DOC" ]]; then
  env_vars=$(grep -oE '[A-Z_]+:\s*z\.' "$AGENT_CONFIG" | sed 's/:.*//' | sort -u)
  for var in $env_vars; do
    if ! grep -q "\`$var\`" "$AGENT_DOC" 2>/dev/null; then
      echo "DRIFT: agent/README.md missing env var: $var" >&2
      DRIFT=1
    fi
  done
fi

# --- 3. backend/README.md vs backend config/index.ts ---
BACKEND_CONFIG="$ROOT/packages/backend/src/config/index.ts"
BACKEND_DOC="$ROOT/packages/backend/README.md"

if [[ -f "$BACKEND_CONFIG" && -f "$BACKEND_DOC" ]]; then
  env_vars=$(grep -oE '[A-Z_]+:\s*z\.' "$BACKEND_CONFIG" | sed 's/:.*//' | sort -u)
  for var in $env_vars; do
    if ! grep -q "\`$var\`" "$BACKEND_DOC" 2>/dev/null; then
      echo "DRIFT: backend/README.md missing env var: $var" >&2
      DRIFT=1
    fi
  done
fi

# --- 4. .node-version vs agent/README.md ---
NODE_VER_FILE="$ROOT/.node-version"
if [[ -f "$NODE_VER_FILE" && -f "$AGENT_DOC" ]]; then
  major=$(head -1 "$NODE_VER_FILE" | cut -d. -f1)
  if ! grep -qE "Node\.js ${major}\." "$AGENT_DOC" 2>/dev/null; then
    echo "DRIFT: agent/README.md Node.js version mismatch (v${major})" >&2
    DRIFT=1
  fi
fi

if [[ $DRIFT -eq 0 ]]; then
  echo "No documentation drift detected." >&2
fi
exit $DRIFT
