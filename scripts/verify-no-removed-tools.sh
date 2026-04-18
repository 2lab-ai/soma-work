#!/usr/bin/env bash
# verify-no-removed-tools.sh
#
# CI guardrail (plan v8 test 67): assert that no caller references the five
# legacy `mcp__llm__*` tools that were collapsed into a single `chat` tool.
#
# Exits 0 on zero matches, 1 otherwise.
#
# Run against source + docs + built output so we catch both hand-written and
# stale-build residue.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The `chat` tool survives, so we search for the four removed names only.
# If a new caller accidentally re-introduces `mcp__llm__chat-reply` (note the
# hyphen), this regex catches it; the plain `chat` match is explicitly
# excluded via the alternation.
PATTERN='mcp__llm__(chat-reply|status|result|cancel)'

SEARCH_PATHS=()
for p in src docs mcp-servers/llm/README.md; do
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
  --exclude='verify-no-removed-tools.sh'
  --exclude='*llm-mcp-server*.test.ts'
)

set +e
MATCHES="$(grep -RnE "${EXCLUDES[@]}" "$PATTERN" "${SEARCH_PATHS[@]}" || true)"
set -e

if [ -n "$MATCHES" ]; then
  echo "ERROR: found references to removed llm MCP tools:"
  echo "$MATCHES"
  exit 1
fi

echo "OK: no references to mcp__llm__(chat-reply|status|result|cancel) found."
exit 0
