#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?usage: install-target.sh TARGET ENV [TARGET_NAME]}"
ENV_NAME="${2:?usage: install-target.sh TARGET ENV [TARGET_NAME]}"
TARGET_NAME="${3:-target}"

cd "$TARGET"

npm ci --omit=dev --workspaces --no-audit --no-fund
node scripts/smoke/mcp-bins.js
node scripts/smoke/resvg-native.js "$TARGET_NAME"
bash scripts/service.sh "$ENV_NAME" install
