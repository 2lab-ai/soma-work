#!/bin/bash
# hook-proxy.sh — Claude Code hook entrypoint for the zworkflow plugin.
#
# Two modes, gated by HOOKS_PROXY_ENABLED:
#   • unset / != "true"  → STANDALONE (default): run the self-contained shell
#       guards (todo-guard.sh / call-tracker.sh). No network, file-based state.
#       This is what an external Claude Code install gets — it must work with no
#       soma-work service present.
#   • "true"             → PROXY: forward events to the soma-work Fastify service
#       (centralized state). soma-work opts in by setting HOOKS_PROXY_ENABLED=true
#       in the spawned agent's env (see buildQueryEnv in query-env-builder.ts).
#
# Why default standalone: the old default ("true") made external installs POST
# to 127.0.0.1:33000, which doesn't exist off a soma-work box → curl fails →
# fail-open → the guard silently did nothing. Defaulting to the shell guard
# matches the plugin's standalone contract.
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

# ── Default STANDALONE: run self-contained shell guards (no service needed) ──
if [[ "${HOOKS_PROXY_ENABLED:-false}" != "true" ]]; then
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
    # Non-blocking warning: service returns {action:"warn", message:"..."}.
    # Surface it to the model via PreToolUse additionalContext (exit 0 = pass).
    # Cheap substring pre-check avoids spawning jq on the common (non-warn) path —
    # this hook runs on every tool call. Single jq pass extracts the message.
    if [[ "$BODY" == *'"warn"'* ]]; then
      WMSG=$(echo "$BODY" | jq -r 'if .action == "warn" then .message else empty end' 2>/dev/null)
      if [[ -n "$WMSG" ]]; then
        jq -n --arg m "$WMSG" \
          '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}' 2>/dev/null || true
      fi
    fi
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
