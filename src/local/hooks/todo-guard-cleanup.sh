#!/bin/bash
# todo-guard-cleanup.sh — Stop hook: 세션 종료 시 todo-guard 상태 파일 정리
#
# Stop hook에서 호출되어 세션별 todo-guard 상태 파일을 삭제합니다.

set -uo pipefail

STATE_DIR="/tmp/claude-calls"

# Read hook input from stdin
if [[ -t 0 ]]; then
  HOOK_INPUT="{}"
else
  HOOK_INPUT=$(cat 2>/dev/null || echo "{}")
fi

# Extract session_id
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null)

if [[ -z "$SESSION_ID" ]]; then
  exit 0
fi

# Sanitize session_id
SAFE_ID=$(echo "$SESSION_ID" | tr -cd '[:alnum:]_-')

# Remove state and lock files/dirs
rm -f "$STATE_DIR/session_${SAFE_ID}.todo_guard.json"
rmdir "$STATE_DIR/session_${SAFE_ID}.todo_guard.lock" 2>/dev/null

exit 0
