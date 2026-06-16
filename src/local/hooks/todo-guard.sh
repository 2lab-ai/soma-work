#!/bin/bash
# todo-guard.sh — PreToolUse hook: blocks execution when TodoWrite has not been called
#
# Behavior:
#   1. Manages a per-session tool call counter via file
#   2. Sets a marker on TodoWrite/TaskCreate/TaskUpdate call → all subsequent tool calls pass
#   3. Emits a non-blocking warning (additionalContext) at the warn threshold (default 3)
#   4. Blocks with feedback if counter >= N (default 5) and no marker
#
# Why: this guard forbids planless, aimless drift — racking up tool calls
# without ever registering what you are doing as a task.
#
# Safety policy: passes on parse failure/missing session_id (fail-open + warning log)
#
# State file: /tmp/claude-calls/session_{id}.todo_guard.json
#   {"count": N, "todo_exists": false, "last_updated": "..."}

set -uo pipefail

# ── Configuration ──
THRESHOLD="${TODO_GUARD_THRESHOLD:-5}"          # hard block at this count
WARN_THRESHOLD="${TODO_GUARD_WARN_THRESHOLD:-3}" # non-blocking warning (< THRESHOLD)
STATE_DIR="/tmp/claude-calls"
mkdir -p "$STATE_DIR" 2>/dev/null || {
  echo "⚠️ todo-guard: cannot create $STATE_DIR, skipping check" >&2
  exit 0
}

# ── Read hook input from stdin ──
if [[ -t 0 ]]; then
  HOOK_INPUT="{}"
else
  HOOK_INPUT=$(cat 2>/dev/null || echo "{}")
fi

# ── Extract fields from JSON ──
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

# ── Always-exempt tools (prevent deadlock) ──
# These tools must never be blocked or counted — blocking them creates a deadlock:
#   ToolSearch blocked → can't load TodoWrite schema → can't call TodoWrite → all tools stuck
# They exit before touching any state files, locks, or counters.
case "$TOOL_NAME" in
  ToolSearch)
    # Required to load deferred tool schemas (e.g. TodoWrite itself)
    exit 0
    ;;
  TodoWrite|TaskCreate|TaskUpdate)
    # Task-tracking tools that satisfy this guard. The guard forbids planless,
    # aimless drift — registering (or updating) a task proves there is a plan,
    # so blocking these tools would be self-defeating.
    #   - TodoWrite sets the marker only with a non-empty todos array.
    #   - TaskCreate/TaskUpdate register a task by the act of calling them,
    #     so they always set the marker.
    if [[ -n "$SESSION_ID" ]]; then
      SET_MARKER="true"
      if [[ "$TOOL_NAME" == "TodoWrite" ]]; then
        TODO_LEN=$(echo "$HOOK_INPUT" | jq '.tool_input.todos | if type == "array" then length else 0 end' 2>/dev/null || echo "0")
        if [[ "$TODO_LEN" -le 0 ]]; then
          SET_MARKER="false"
          echo "⚠️ todo-guard: TodoWrite with empty/invalid payload — marker not set" >&2
        fi
      fi
      if [[ "$SET_MARKER" == "true" ]]; then
        SAFE_ID=$(echo "$SESSION_ID" | tr -cd '[:alnum:]_-')
        STATE_FILE="$STATE_DIR/session_${SAFE_ID}.todo_guard.json"
        LOCK_DIR="$STATE_DIR/session_${SAFE_ID}.todo_guard.lock"
        LOCK_ATTEMPTS=0
        while ! mkdir "$LOCK_DIR" 2>/dev/null; do
          LOCK_ATTEMPTS=$((LOCK_ATTEMPTS + 1))
          if [[ $LOCK_ATTEMPTS -ge 50 ]]; then
            echo "⚠️ todo-guard: lock timeout in $TOOL_NAME, marker not set" >&2
            exit 0
          fi
          sleep 0.01
        done
        trap "rmdir '$LOCK_DIR' 2>/dev/null" EXIT
        COUNT=$(jq -r '.count // 0' "$STATE_FILE" 2>/dev/null || echo "0")
        NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')
        echo "{\"count\":$COUNT,\"todo_exists\":true,\"last_updated\":\"$NOW\"}" > "$STATE_FILE"
      fi
    fi
    exit 0
    ;;
esac

# ── Fail-open: no session_id → skip ──
if [[ -z "$SESSION_ID" ]]; then
  echo "⚠️ todo-guard: session_id missing, skipping check" >&2
  exit 0
fi

# ── Sanitize session_id for filename safety ──
SAFE_ID=$(echo "$SESSION_ID" | tr -cd '[:alnum:]_-')
STATE_FILE="$STATE_DIR/session_${SAFE_ID}.todo_guard.json"
LOCK_DIR="$STATE_DIR/session_${SAFE_ID}.todo_guard.lock"

# ── Acquire lock (mkdir-based, same pattern as call-tracker.sh) ──
LOCK_ATTEMPTS=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  LOCK_ATTEMPTS=$((LOCK_ATTEMPTS + 1))
  if [[ $LOCK_ATTEMPTS -ge 50 ]]; then
    echo "⚠️ todo-guard: lock timeout, skipping check" >&2
    exit 0
  fi
  sleep 0.01
done
# Ensure lock is always released
trap "rmdir '$LOCK_DIR' 2>/dev/null" EXIT

# ── Read current state ──
if [[ -f "$STATE_FILE" ]]; then
  COUNT=$(jq -r '.count // 0' "$STATE_FILE" 2>/dev/null || echo "0")
  TODO_EXISTS=$(jq -r '.todo_exists // false' "$STATE_FILE" 2>/dev/null || echo "false")
else
  COUNT=0
  TODO_EXISTS="false"
fi

NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')

# ── Already has todos → pass ──
if [[ "$TODO_EXISTS" == "true" ]]; then
  exit 0
fi

# ── Increment counter ──
COUNT=$((COUNT + 1))
echo "{\"count\":$COUNT,\"todo_exists\":false,\"last_updated\":\"$NOW\"}" > "$STATE_FILE"

# ── Check hard block threshold ──
if [[ $COUNT -ge $THRESHOLD ]]; then
  echo "⚠️ Detected ${THRESHOLD} or more tool calls without TodoWrite/TaskCreate/TaskUpdate." >&2
  echo "This guard forbids planless, aimless drift — register what you're doing as a task first." >&2
  echo "" >&2
  echo "TodoWrite example:" >&2
  echo '  TodoWrite({ todos: [{ content: "Task description", status: "pending", activeForm: "In progress" }] })' >&2
  echo "Or register a task with TaskCreate / TaskUpdate." >&2
  exit 2
fi

# ── Early, non-blocking warning (fires once, at the warn threshold) ──
# Surfaced to the model via PreToolUse additionalContext; exit 0 = call proceeds.
if [[ $WARN_THRESHOLD -gt 0 && $WARN_THRESHOLD -lt $THRESHOLD && $COUNT -eq $WARN_THRESHOLD ]]; then
  WARN_MSG="⚠️ 태스크 없이 ${WARN_THRESHOLD}회 작업했습니다. TodoWrite/TaskCreate 없이는 최대 ${THRESHOLD}회까지만 가능 — 지금 TodoWrite 또는 TaskCreate로 태스크를 등록하세요."
  jq -n --arg m "$WARN_MSG" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}' 2>/dev/null || true
  exit 0
fi

exit 0
