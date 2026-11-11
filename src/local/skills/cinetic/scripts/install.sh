#!/usr/bin/env bash
# Fetch the upstream cinetic skill (Leonxlnx/cinetic, MIT) at the pinned commit and print its skill root.
# The checkout lives outside the plugin (CINETIC_HOME/<pin>, default ~/.cache/cinetic/<pin>): the skill is 18 MB of scripts,
# references and a Remotion starter, so it is pinned here, not vendored. Re-running is cheap: a finished checkout is
# returned at once. Override the pin for a trial with CINETIC_PIN=<sha>; CINETIC_REPO points at a mirror (or a test fixture).
set -euo pipefail
PIN="${CINETIC_PIN:-f4bbfc844877891fe92279d47b7874fb44d485ae}"
REPO="${CINETIC_REPO:-https://github.com/Leonxlnx/cinetic.git}"
[[ "$PIN" =~ ^[0-9a-f]{7,40}$ ]] || { echo "cinetic: CINETIC_PIN must be a commit sha, got '$PIN'" >&2; exit 1; }
BASE="${CINETIC_HOME:-$HOME/.cache/cinetic}"
# one checkout per pin: a trial pin never swaps the files under a skill root another run already got
DIR="$BASE/$PIN"
ROOT="$DIR/skills/cinetic"
finished() { [ -f "$DIR/.cinetic-ok" ]; }
if ! finished; then
  mkdir -p "$BASE"
  # one installer per pin at a time: a second first run waits for the first instead of cloning into the same directory.
  # The lock holds its owner's pid; a lock whose owner is gone (killed mid-install) is taken over, not waited on.
  LOCK="$DIR.lock"
  tries=0
  until mkdir "$LOCK" 2>/dev/null; do
    # a reclaim mutex left by a reclaimer that was killed is itself stale after a minute
    [ -z "$(find "$LOCK.reclaim" -maxdepth 0 -mmin +1 2>/dev/null)" ] || rmdir "$LOCK.reclaim" 2>/dev/null || true
    owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    # stale: its owner is gone, or it never got a pid (killed between mkdir and the write) and is over a minute old
    if { if [ -n "$owner" ]; then ! kill -0 "$owner" 2>/dev/null; else [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; fi; } &&
      mkdir "$LOCK.reclaim" 2>/dev/null; then
      # one reclaimer at a time, and only the lock that still names the same owner: a lock another run has just
      # taken (with a live pid) is never removed
      if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$owner" ]; then rm -rf "$LOCK"; fi
      rmdir "$LOCK.reclaim"
      continue
    fi
    if [ "$tries" -ge 600 ]; then
      echo "cinetic: $LOCK has been held for 2 minutes by pid ${owner:-?}; remove it if no install is running" >&2
      exit 1
    fi
    sleep 0.2
    tries=$((tries + 1))
  done
  trap 'rm -rf "$LOCK"' EXIT # armed before the pid is written: an interrupted write leaves no lock
  echo $$ >"$LOCK/pid"
  if ! finished; then
    rm -rf "$DIR" # a checkout without the finished mark is an interrupted install: start it over
    git clone --quiet --filter=blob:none --no-checkout "$REPO" "$DIR"
    git -C "$DIR" -c advice.detachedHead=false checkout --quiet "$PIN"
    touch "$DIR/.cinetic-ok"
  fi
fi
[ -f "$ROOT/SKILL.md" ] || { echo "cinetic: $ROOT/SKILL.md missing at $PIN" >&2; exit 1; }
echo "$ROOT"
