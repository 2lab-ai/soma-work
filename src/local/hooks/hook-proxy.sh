#!/bin/bash
# hook-proxy.sh — Thin HTTP proxy for Claude Code hooks
# Routes hook events to soma-work Fastify service.
# All business logic lives in the service; this script only forwards.
#
# Usage: hook-proxy.sh <pre_tool_use|post_tool_use|cleanup>
# Exit codes: 0 = pass, 2 = blocked (pre_tool_use only)
#
# Safety: fail-open on ALL errors (network, timeout, parse failure)

set -uo pipefail

EVENT="${1:-}"

if [[ -z "$EVENT" ]]; then
  echo "Usage: hook-proxy.sh <pre_tool_use|post_tool_use|cleanup>" >&2
  exit 0
fi

# ── Rollback: disabled proxy → delegate to legacy scripts ──
if [[ "${HOOKS_PROXY_ENABLED:-true}" != "true" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  if [[ -t 0 ]]; then
    HOOK_INPUT="{}"
  else
    HOOK_INPUT=$(cat 2>/dev/null || echo "{}")
  fi
  case "$EVENT" in
    pre_tool_use)
      echo "$HOOK_INPUT" | "$SCRIPT_DIR/todo-guard.sh"
      TODO_EXIT=$?
      TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
      case "$TOOL_NAME" in
        Task|mcp__*) echo "$HOOK_INPUT" | "$SCRIPT_DIR/call-tracker.sh" pre ;;
      esac
      exit $TODO_EXIT
      ;;
    post_tool_use)
      TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
      case "$TOOL_NAME" in
        Task|mcp__*) echo "$HOOK_INPUT" | "$SCRIPT_DIR/call-tracker.sh" post ;;
      esac
      exit 0
      ;;
    cleanup)
      echo "$HOOK_INPUT" | "$SCRIPT_DIR/todo-guard-cleanup.sh"
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

# ── Extract tool name ──
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# ── Exempt tools: exit immediately, no HTTP, no state ──
# These must never be blocked or counted. Shell short-circuits before
# any I/O to prevent deadlock (ToolSearch → load TodoWrite schema).
case "$TOOL_NAME" in
  ToolSearch)
    exit 0
    ;;
  TodoWrite)
    if [[ "$EVENT" == "pre_tool_use" ]]; then
      # Sync POST to set marker — never blocks (exit 0 regardless)
      curl -s --max-time 0.3 --connect-timeout 0.1 \
        -X POST "http://127.0.0.1:${SOMA_HOOK_PORT:-${CONVERSATION_VIEWER_PORT:-33000}}/api/hooks/v1/${EVENT}" \
        -H "Content-Type: application/json" \
        -d "$HOOK_INPUT" >/dev/null 2>&1 || true
    fi
    exit 0
    ;;
esac

# ── Determine service port ──
# Priority: SOMA_HOOK_PORT > CONVERSATION_VIEWER_PORT > 33000 (dev default)
PORT="${SOMA_HOOK_PORT:-${CONVERSATION_VIEWER_PORT:-33000}}"

# ── Forward to service ──
RESPONSE=$(curl -s --max-time 0.5 --connect-timeout 0.15 \
  -w "\n%{http_code}" \
  -X POST "http://127.0.0.1:${PORT}/api/hooks/v1/${EVENT}" \
  -H "Content-Type: application/json" \
  -d "$HOOK_INPUT" 2>/dev/null) || {
  # curl failed — fail-open
  exit 0
}

# ── Parse response ──
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

case "$HTTP_CODE" in
  200|202)
    exit 0
    ;;
  403)
    # Blocked by service — extract message and emit to stderr
    MSG=$(echo "$BODY" | jq -r '.message // empty' 2>/dev/null)
    if [[ -n "$MSG" ]]; then
      echo "$MSG" >&2
    fi
    exit 2
    ;;
  *)
    # Unknown status — fail-open
    echo "⚠️ hook-proxy: unexpected status $HTTP_CODE, passing" >&2
    exit 0
    ;;
esac
