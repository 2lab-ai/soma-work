#!/bin/bash
# todo-guard.test.sh — Tests for todo-guard.sh hook
#
# Run: bash src/local/hooks/todo-guard.test.sh
# Exit code: 0 = all passed, 1 = has failures

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/todo-guard.sh"
CLEANUP="$SCRIPT_DIR/todo-guard-cleanup.sh"

# Test state isolation — unique per test run
TEST_STATE_DIR="/tmp/claude-calls-test-$$"
PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Helpers ──

setup() {
  rm -rf "$TEST_STATE_DIR"
  mkdir -p "$TEST_STATE_DIR"
  # Create a patched copy of the hook with our test state dir
  sed "s|STATE_DIR=\"/tmp/claude-calls\"|STATE_DIR=\"$TEST_STATE_DIR\"|" "$HOOK" > "$TEST_STATE_DIR/hook.sh"
  chmod +x "$TEST_STATE_DIR/hook.sh"
  # Patched cleanup
  sed "s|STATE_DIR=\"/tmp/claude-calls\"|STATE_DIR=\"$TEST_STATE_DIR\"|" "$CLEANUP" > "$TEST_STATE_DIR/cleanup.sh"
  chmod +x "$TEST_STATE_DIR/cleanup.sh"
}

teardown() {
  rm -rf "$TEST_STATE_DIR"
}

run() {
  local json="$1"
  local threshold="${2:-5}"
  echo "$json" | TODO_GUARD_THRESHOLD="$threshold" bash "$TEST_STATE_DIR/hook.sh" 2>/dev/null
  return $?
}

run_stderr() {
  local json="$1"
  local threshold="${2:-5}"
  echo "$json" | TODO_GUARD_THRESHOLD="$threshold" bash "$TEST_STATE_DIR/hook.sh" 2>&1 >/dev/null
  return $?
}

make_input() {
  local session_id="$1"
  local tool_name="$2"
  local tool_input
  tool_input="${3:-"{}"}"
  echo "{\"session_id\":\"$session_id\",\"tool_name\":\"$tool_name\",\"tool_input\":$tool_input}"
}

assert_exit() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$actual" -eq "$expected" ]]; then
    echo -e "  ${GREEN}✓${NC} $test_name (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $test_name (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -q "$expected"; then
    echo -e "  ${GREEN}✓${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $test_name (expected '$expected' in output)"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_field() {
  local test_name="$1"
  local filepath="$2"
  local field="$3"
  local expected="$4"
  TOTAL=$((TOTAL + 1))
  local actual
  actual=$(jq -r "$field" "$filepath" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    echo -e "  ${GREEN}✓${NC} $test_name ($field = $actual)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $test_name ($field: expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_not_exists() {
  local test_name="$1"
  local filepath="$2"
  TOTAL=$((TOTAL + 1))
  if [[ ! -e "$filepath" ]]; then
    echo -e "  ${GREEN}✓${NC} $test_name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $test_name (exists: $filepath)"
    FAIL=$((FAIL + 1))
  fi
}

# ═══════════════════════════════════════
echo -e "${YELLOW}═══ todo-guard.sh Tests ═══${NC}"
echo ""

# ── Test 1: 4 calls → all pass ──
echo "Test 1: 4 calls → all pass"
setup
for i in 1 2 3 4; do
  run "$(make_input "test1" "Read")"
  assert_exit "Call $i passes" 0 $?
done
echo ""

# ── Test 2: 5 calls → blocked on 5th ──
echo "Test 2: 5 calls → blocked on 5th"
setup
for i in 1 2 3 4; do
  run "$(make_input "test2" "Bash")"
  assert_exit "Call $i passes" 0 $?
done
run "$(make_input "test2" "Edit")"
assert_exit "Call 5 blocked" 2 $?
echo ""

# ── Test 3: 6 calls → blocked from 5th onward ──
echo "Test 3: 6 calls → blocked from 5th onward"
setup
for i in 1 2 3 4; do
  run "$(make_input "test3" "Grep")" >/dev/null
done
run "$(make_input "test3" "Write")"
assert_exit "Call 5 blocked" 2 $?
run "$(make_input "test3" "Write")"
assert_exit "Call 6 still blocked" 2 $?
echo ""

# ── Test 4: 5th call is TodoWrite → marker set + subsequent calls pass ──
echo "Test 4: 5th call is TodoWrite → marker set + subsequent calls pass"
setup
for i in 1 2 3 4; do
  run "$(make_input "test4" "Read")" >/dev/null
done
run "$(make_input "test4" "TodoWrite" '{"todos":[{"content":"task","status":"pending","activeForm":"working"}]}')"
assert_exit "Call 5 (TodoWrite) passes" 0 $?
assert_json_field "todo_exists marker set" "$TEST_STATE_DIR/session_test4.todo_guard.json" ".todo_exists" "true"
run "$(make_input "test4" "Write")"
assert_exit "Call 6 passes (todos exist)" 0 $?
run "$(make_input "test4" "Bash")"
assert_exit "Call 7 passes (todos exist)" 0 $?
echo ""

# ── Test 5: Empty TodoWrite → marker not set but call passes ──
echo "Test 5: Empty TodoWrite (todos: []) → marker not set, but always passes"
setup
for i in 1 2 3; do
  run "$(make_input "test5" "Read")" >/dev/null
done
run "$(make_input "test5" "TodoWrite" '{"todos":[]}')"
assert_exit "Empty TodoWrite passes (always exempt)" 0 $?
# Empty TodoWrite is not counted, so count stays at 3
assert_json_field "count is 3" "$TEST_STATE_DIR/session_test5.todo_guard.json" ".count" "3"
run "$(make_input "test5" "Read")" >/dev/null
run "$(make_input "test5" "Edit")"
assert_exit "Call 5 blocked (empty TodoWrite didn't set marker)" 2 $?
echo ""

# ── Test 5b: ToolSearch → always passes, counter not incremented ──
echo "Test 5b: ToolSearch → always passes (deadlock prevention)"
setup
for i in 1 2 3 4 5; do
  run "$(make_input "test5b" "Read")" >/dev/null
done
# ToolSearch call after threshold exceeded
run "$(make_input "test5b" "ToolSearch")"
assert_exit "ToolSearch passes even after threshold" 0 $?
# ToolSearch does not touch state file, so count stays at 5
assert_json_field "count unchanged at 5" "$TEST_STATE_DIR/session_test5b.todo_guard.json" ".count" "5"
echo ""

# ── Test 5c: ToolSearch → not counted toward threshold ──
echo "Test 5c: ToolSearch is not counted toward threshold"
setup
for i in 1 2 3; do
  run "$(make_input "test5c" "Read")" >/dev/null
done
# Multiple ToolSearch calls
for i in 1 2 3 4 5; do
  run "$(make_input "test5c" "ToolSearch")"
  assert_exit "ToolSearch $i passes" 0 $?
done
# Count should still be 3
assert_json_field "count still 3 after ToolSearch calls" "$TEST_STATE_DIR/session_test5c.todo_guard.json" ".count" "3"
# 4th regular call should also pass (count=4 < threshold=5)
run "$(make_input "test5c" "Bash")"
assert_exit "Call 4 passes (ToolSearch didn't count)" 0 $?
echo ""

# ── Test 6: malformed stdin → passes ──
echo "Test 6: malformed stdin → passes (fail-open)"
setup
echo "not json at all" | bash "$TEST_STATE_DIR/hook.sh" 2>/dev/null
assert_exit "Malformed stdin passes" 0 $?
echo ""

# ── Test 7: no session_id → passes ──
echo "Test 7: no session_id → passes"
setup
echo '{"tool_name":"Edit"}' | bash "$TEST_STATE_DIR/hook.sh" 2>/dev/null
assert_exit "No session_id passes" 0 $?
echo ""

# ── Test 8: existing marker → immediate pass ──
echo "Test 8: existing marker → immediate pass"
setup
echo '{"count":10,"todo_exists":true,"last_updated":"2026-04-09T00:00:00Z"}' > "$TEST_STATE_DIR/session_test8.todo_guard.json"
run "$(make_input "test8" "Bash")"
assert_exit "Passes with existing marker" 0 $?
echo ""

# ── Test 9: feedback message on block ──
echo "Test 9: feedback message on block"
setup
for i in 1 2 3 4; do
  run "$(make_input "test9" "Read")" >/dev/null
done
STDERR=$(run_stderr "$(make_input "test9" "Write")")
assert_contains "Contains TodoWrite mention" "TodoWrite" "$STDERR"
assert_contains "Contains threshold mention" "5" "$STDERR"
echo ""

# ── Test 10: cleanup hook → state file deleted ──
echo "Test 10: cleanup hook → state file deleted"
setup
echo '{"count":3,"todo_exists":false}' > "$TEST_STATE_DIR/session_test10.todo_guard.json"
mkdir -p "$TEST_STATE_DIR/session_test10.todo_guard.lock"
echo '{"session_id":"test10"}' | bash "$TEST_STATE_DIR/cleanup.sh" 2>/dev/null
assert_file_not_exists "State file deleted" "$TEST_STATE_DIR/session_test10.todo_guard.json"
assert_file_not_exists "Lock dir deleted" "$TEST_STATE_DIR/session_test10.todo_guard.lock"
echo ""

# ── Test 11: custom threshold (N=3) ──
echo "Test 11: custom threshold (N=3)"
setup
for i in 1 2; do
  run "$(make_input "test11" "Read")" 3
  assert_exit "Call $i passes (threshold=3)" 0 $?
done
run "$(make_input "test11" "Edit")" 3
assert_exit "Call 3 blocked (threshold=3)" 2 $?
echo ""

# ── Test 12: concurrency — 5 simultaneous calls → counter exactly 5 ──
echo "Test 12: concurrency — 5 simultaneous calls → counter exactly 5"
setup
for i in 1 2 3 4 5; do
  echo "$(make_input "test12" "Read")" | bash "$TEST_STATE_DIR/hook.sh" 2>/dev/null &
done
wait
FINAL_COUNT=$(jq -r '.count' "$TEST_STATE_DIR/session_test12.todo_guard.json" 2>/dev/null || echo "0")
TOTAL=$((TOTAL + 1))
if [[ "$FINAL_COUNT" -eq 5 ]]; then
  echo -e "  ${GREEN}✓${NC} Concurrent count is exactly 5 (got $FINAL_COUNT)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} Concurrent count should be 5 (got $FINAL_COUNT)"
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Test 13: counter accuracy — 3 calls then count=3 ──
echo "Test 13: counter accuracy — 3 calls then count=3"
setup
for i in 1 2 3; do
  run "$(make_input "test13" "Glob")" >/dev/null
done
assert_json_field "count is 3" "$TEST_STATE_DIR/session_test13.todo_guard.json" ".count" "3"
echo ""

# ── Test 14: different sessions are independent ──
echo "Test 14: session isolation — different session counters are independent"
setup
for i in 1 2 3 4; do
  run "$(make_input "session_a" "Read")" >/dev/null
done
run "$(make_input "session_b" "Read")" >/dev/null
assert_json_field "Session A count=4" "$TEST_STATE_DIR/session_session_a.todo_guard.json" ".count" "4"
assert_json_field "Session B count=1" "$TEST_STATE_DIR/session_session_b.todo_guard.json" ".count" "1"
echo ""

# ── Test 15: no session_id + ToolSearch → passes + no state file created ──
echo "Test 15: ToolSearch without session_id → passes, no state file created"
setup
echo '{"tool_name":"ToolSearch"}' | bash "$TEST_STATE_DIR/hook.sh" 2>/dev/null
assert_exit "ToolSearch without session_id passes" 0 $?
# Verify no state file was created
STATE_FILES=$(ls "$TEST_STATE_DIR"/session_*.json 2>/dev/null | wc -l)
TOTAL=$((TOTAL + 1))
if [[ "$STATE_FILES" -eq 0 ]]; then
  echo -e "  ${GREEN}✓${NC} No state files created"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} State files unexpectedly created ($STATE_FILES found)"
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Test 16: corrupted state file + exempt tools → pass ──
echo "Test 16: corrupted state file + ToolSearch/TodoWrite still pass"
setup
# Write corrupted JSON to state file
echo "NOT VALID JSON {{{{" > "$TEST_STATE_DIR/session_test16.todo_guard.json"
run "$(make_input "test16" "ToolSearch")"
assert_exit "ToolSearch passes with corrupted state" 0 $?
run "$(make_input "test16" "TodoWrite" '{"todos":[{"content":"task","status":"pending","activeForm":"working"}]}')"
assert_exit "TodoWrite passes with corrupted state" 0 $?
echo ""

# ── Test 17: consecutive empty TodoWrite → counter unchanged + regular tool blocked ──
echo "Test 17: consecutive empty TodoWrite → counter unchanged, regular tool blocked"
setup
for i in 1 2 3 4; do
  run "$(make_input "test17" "Read")" >/dev/null
done
# 5 consecutive empty TodoWrite calls
for i in 1 2 3 4 5; do
  run "$(make_input "test17" "TodoWrite" '{"todos":[]}')"
  assert_exit "Empty TodoWrite $i passes" 0 $?
done
# Counter stays at 4 (empty TodoWrite doesn't increment counter)
assert_json_field "count still 4 after empty TodoWrites" "$TEST_STATE_DIR/session_test17.todo_guard.json" ".count" "4"
# Next regular tool call is the 5th, so it gets blocked
run "$(make_input "test17" "Edit")"
assert_exit "Regular tool blocked at threshold" 2 $?
echo ""

# ═══════════════════════════════════════
teardown
echo -e "${YELLOW}═══ Results ═══${NC}"
echo -e "Total: $TOTAL | ${GREEN}Pass: $PASS${NC} | ${RED}Fail: $FAIL${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL PASSED${NC}"
  exit 0
fi
