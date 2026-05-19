#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?usage: install-target.sh TARGET ENV [TARGET_NAME]}"
ENV_NAME="${2:?usage: install-target.sh TARGET ENV [TARGET_NAME]}"
TARGET_NAME="${3:-target}"

cd "$TARGET"

# --include-workspace-root is required so root runtime deps (e.g. fastify,
# @anthropic-ai/claude-agent-sdk, @resvg/resvg-js — see root package.json)
# are also installed. Without it, --workspaces installs only workspaces and
# dist/index.js fails to start. See PR #960 review (P1 finding #1).
npm ci --omit=dev --workspaces --include-workspace-root --no-audit --no-fund
node scripts/smoke/mcp-bins.js
node scripts/smoke/resvg-native.js "$TARGET_NAME"
bash scripts/service.sh "$ENV_NAME" install
