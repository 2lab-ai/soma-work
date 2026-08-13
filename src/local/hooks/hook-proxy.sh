#!/bin/bash
# hook-proxy.sh — Claude Code hook entrypoint for the zworkflow plugin.
#
# Two modes, gated by HOOKS_PROXY_ENABLED:
#   • unset / != "true"  → STANDALONE (default): run the self-contained shell
#       tracker (call-tracker.sh). No network, file-based state.
#       This is what an external Claude Code install gets — it must work with no
#       soma-work service present.
#   • "true"             → PROXY: forward events to the soma-work Fastify service
#       (centralized state). soma-work opts in by setting HOOKS_PROXY_ENABLED=true
#       in the spawned agent's env (see buildQueryEnv in query-env-builder.ts).
#
# Why default standalone: the old default ("true") made external installs POST
# to 127.0.0.1:33000, which doesn't exist off a soma-work box → curl fails →
# fail-open → the hook silently did nothing. Defaulting to the shell tracker
# matches the plugin's standalone contract.
#
# Usage: hook-proxy.sh <pre_tool_use|post_tool_use|cleanup>
# Exit code: always 0 — these hooks observe, they never block a tool call.
#
# Safety: fail-open on ALL errors (network, timeout, parse failure)

set -uo pipefail

EVENT="${1:-}"

if [[ -z "$EVENT" ]]; then
  echo "Usage: hook-proxy.sh <pre_tool_use|post_tool_use|cleanup>" >&2
  exit 0
fi

# ── Default STANDALONE: run the self-contained shell tracker (no service needed) ──
if [[ "${HOOKS_PROXY_ENABLED:-false}" != "true" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [[ -t 0 ]]; then
    HOOK_INPUT="{}"
  else
    HOOK_INPUT=$(cat 2>/dev/null || echo "{}")
  fi
  case "$EVENT" in
    pre_tool_use)
      TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
      case "$TOOL_NAME" in
        Task|mcp__*) echo "$HOOK_INPUT" | "$SCRIPT_DIR/call-tracker.sh" pre ;;
      esac
      exit 0
      ;;
    post_tool_use)
      TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
      case "$TOOL_NAME" in
        Task|mcp__*) echo "$HOOK_INPUT" | "$SCRIPT_DIR/call-tracker.sh" post ;;
      esac
      exit 0
      ;;
    cleanup)
      # Standalone mode keeps no per-session guard state — nothing to clean up.
      exit 0
      ;;
  esac
  exit 0
fi

# ── Read hook input from stdin ──
if [[ -t 0 ]]; then
  HOOK_INPUT="{}"
else
  HOOK_INPUT=$(cat 2>/dev/null || echo "{}")
fi

# ── Skip the roundtrip for untracked tools ──
# The service only logs Task / MCP calls; every other pre/post event would be a
# no-op POST on a hook that fires for EVERY tool call. `cleanup` carries no
# tool_name and must always be forwarded.
if [[ "$EVENT" != "cleanup" ]]; then
  TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
  case "$TOOL_NAME" in
    Task|mcp__*) ;;
    *) exit 0 ;;
  esac
fi

# ── Determine service port ──
# Priority: SOMA_HOOK_PORT > CONVERSATION_VIEWER_PORT > 33000 (dev default)
PORT="${SOMA_HOOK_PORT:-${CONVERSATION_VIEWER_PORT:-33000}}"

# ── Forward to service (fire and forget) ──
# The service observes only — it never blocks a tool call, so the response is
# irrelevant and every path exits 0.
curl -s --max-time 0.5 --connect-timeout 0.15 \
  -X POST "http://127.0.0.1:${PORT}/api/hooks/v1/${EVENT}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_INPUT" >/dev/null 2>&1 || true

exit 0
