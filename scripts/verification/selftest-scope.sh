#!/usr/bin/env bash
#
# selftest-scope.sh — decide whether Lean Verify must run `lean-verify.sh --selftest` for this event.
#
# `--selftest` plants each forbidden construct in a scratch copy of verification/lean and checks that
# the gate rejects it. It tests the gate — scripts/verification/, the Lean tree under
# verification/ and the workflow that runs them — not the application code a pull request changes.
# For a pull request that touches none of those, it reruns, on identical inputs, the self-test that
# already passed on main: about 12 of the job's 16 minutes on the single self-hosted runner.
#
#   push (main) or any event that is not a pull request   -> selftest=true
#   pull request whose diff touches a gate input          -> selftest=true
#   pull request whose diff touches no gate input         -> selftest=false
#   anything unknown (no base SHA, base not fetchable, diff failed) -> selftest=true (fail-safe)
#
# Inputs (environment, never interpolated into the script): EVENT_NAME, BASE_SHA.
# Output: `selftest=true|false` appended to $GITHUB_OUTPUT when set, and printed with the reason.
#
# The diff is between the base commit and HEAD (the pull request's merge commit), which compares
# two trees and needs no history, so a depth-1 checkout plus a depth-1 fetch of the base is enough.
# If main moved after the event, the diff can include main's own changes; that can only add a
# self-test run, never drop one.

set -uo pipefail

# Paths whose change can change the self-test's outcome. Keep in step with the contract test
# (scripts/__tests__/ci-workflow-contract.test.ts) and verification/README.md.
GATE_INPUTS='^(verification/|scripts/verification/|\.github/workflows/lean-verify\.yml$)'

decide() {
  if [ "${EVENT_NAME:-}" != pull_request ]; then
    echo "true event '${EVENT_NAME:-}' is not a pull request"
    return
  fi
  local base="${BASE_SHA:-}"
  if [ -z "$base" ]; then
    echo "true no base SHA"
    return
  fi
  if ! git cat-file -e "${base}^{commit}" 2>/dev/null &&
    ! git fetch --no-tags --quiet --depth=1 origin "$base" 2>/dev/null; then
    echo "true base $base not fetchable"
    return
  fi
  local files
  # --no-renames: a file moved out of verification/ must still count as a change under it.
  if ! files="$(git diff --no-renames --name-only "$base" HEAD 2>/dev/null)"; then
    echo "true diff against $base failed"
    return
  fi
  local hits
  hits="$(grep -E "$GATE_INPUTS" <<<"$files" || true)"
  if [ -n "$hits" ]; then
    echo "true gate inputs changed: $(head -n 3 <<<"$hits" | paste -sd ' ' -)"
  else
    echo "false no change under verification/, scripts/verification/ or the Lean workflow"
  fi
}

result="$(decide)"
verdict="${result%% *}"
echo "selftest-scope: selftest=$verdict (${result#* })"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "selftest=$verdict" >>"$GITHUB_OUTPUT"
fi
