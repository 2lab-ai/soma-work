#!/bin/bash
# todo-guard.sh — PreToolUse hook: TodoWrite 미호출 시 강제 차단
#
# 동작:
#   1. 세션당 tool call 카운터를 파일로 관리
#   2. TodoWrite 호출 시 마커 설정 → 이후 모든 tool call 통과
#   3. 카운터 >= N (기본 5) 이고 마커 없으면 차단 + 피드백
#
# 안전 정책: 파싱 실패/session_id 누락 시 통과 (fail-open + 경고 로그)
#
# 상태 파일: /tmp/claude-calls/session_{id}.todo_guard.json
#   {"count": N, "todo_exists": false, "last_updated": "..."}

set -uo pipefail

# ── Configuration ──
THRESHOLD="${TODO_GUARD_THRESHOLD:-5}"
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

# ── Fail-open: no session_id → skip ──
if [[ -z "$SESSION_ID" ]]; then
  echo "⚠️ todo-guard: session_id missing, skipping check" >&2
  exit 0
fi

# ── Sanitize session_id for filename safety ──
SAFE_ID=$(echo "$SESSION_ID" | tr -cd '[:alnum:]_-')
STATE_FILE="$STATE_DIR/session_${SAFE_ID}.todo_guard.json"
LOCK_DIR="$STATE_DIR/session_${SAFE_ID}.todo_guard.lock"

# ── Check if TodoWrite with valid payload ──
IS_TODO_WRITE=false
if [[ "$TOOL_NAME" == "TodoWrite" ]]; then
  # Validate: tool_input.todos must be a non-empty array
  TODO_LEN=$(echo "$HOOK_INPUT" | jq '.tool_input.todos | if type == "array" then length else 0 end' 2>/dev/null || echo "0")
  if [[ "$TODO_LEN" -gt 0 ]]; then
    IS_TODO_WRITE=true
  fi
fi

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

# ── TodoWrite with valid payload → mark and pass ──
if [[ "$IS_TODO_WRITE" == "true" ]]; then
  echo "{\"count\":$COUNT,\"todo_exists\":true,\"last_updated\":\"$NOW\"}" > "$STATE_FILE"
  exit 0
fi

# ── Already has todos → pass ──
if [[ "$TODO_EXISTS" == "true" ]]; then
  exit 0
fi

# ── Increment counter ──
COUNT=$((COUNT + 1))
echo "{\"count\":$COUNT,\"todo_exists\":false,\"last_updated\":\"$NOW\"}" > "$STATE_FILE"

# ── Check threshold ──
if [[ $COUNT -ge $THRESHOLD ]]; then
  echo "⚠️ TodoWrite 없이 ${THRESHOLD}회 이상 tool call이 감지되었습니다." >&2
  echo "먼저 TodoWrite로 태스크를 등록하세요." >&2
  echo "" >&2
  echo "TodoWrite 예시:" >&2
  echo '  TodoWrite({ todos: [{ content: "작업 내용", status: "pending", activeForm: "작업 중" }] })' >&2
  exit 2
fi

exit 0
