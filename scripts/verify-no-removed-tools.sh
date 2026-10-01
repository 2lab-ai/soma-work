#!/usr/bin/env bash
# verify-no-removed-tools.sh
#
# CI guardrail: the internal `llm` MCP server (`mcp__llm__chat` and its four
# legacy siblings) was removed — external-model consults now dispatch the
# zworkflow subagents (`astra-zhuge` / `grok-elon` / `fable-zhuge`) directly.
# Assert that no caller references ANY `mcp__llm__*` tool.
#
# Exits 0 on zero matches, 1 otherwise.
#
# Run against source + current docs + scripts + built output so we catch both
# hand-written and stale-build residue. `docs/archive` is historical and is
# intentionally excluded.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PATTERN='mcp__llm__'

SEARCH_PATHS=()
for p in src docs scripts packages; do
  if [ -e "$p" ]; then SEARCH_PATHS+=("$p"); fi
done
# `dist` is the CI-built artifact directory. Include only if it exists
# (tests do not require a build step).
if [ -d dist ]; then SEARCH_PATHS+=("dist"); fi

if [ "${#SEARCH_PATHS[@]}" -eq 0 ]; then
  echo "verify-no-removed-tools: no search paths available — nothing to check."
  exit 0
fi

# The integration-check list *must not* include this script itself or the test
# that asserts the behavior, since those legitimately mention the removed names.
EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=archive
  --exclude='verify-no-removed-tools.sh'
  --exclude='llm-mcp-removal-contract.test.ts'
)

set +e
MATCHES="$(grep -RnE "${EXCLUDES[@]}" "$PATTERN" "${SEARCH_PATHS[@]}" || true)"
set -e

if [ -n "$MATCHES" ]; then
  echo "ERROR: found references to the removed llm MCP server tools (mcp__llm__*):"
  echo "$MATCHES"
  exit 1
fi

echo "OK: no references to mcp__llm__* found."
exit 0
