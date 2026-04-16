#!/usr/bin/env bash
# slack-manifest-rollback.sh — Tier 3 rollback for the /z unified command refactor.
#
# Restores slack-app-manifest.json to the pre-#506 state captured in
# slack-app-manifest.prev.json. Print instructions for the operator to upload
# the restored manifest to Slack.
#
# USAGE:
#   bash scripts/slack-manifest-rollback.sh           # interactive (prompt before write)
#   bash scripts/slack-manifest-rollback.sh --yes     # non-interactive
#   bash scripts/slack-manifest-rollback.sh --dry-run # show diff only, no write
#
# Related: docs/ops/rollback-z-refactor.md
# Tier hierarchy (fastest → slowest to revert):
#   Tier 1: SOMA_ENABLE_LEGACY_SLASH=true  (env flag, instant, no redeploy)
#   Tier 2: git revert <z-refactor commits> + redeploy
#   Tier 3: manifest rollback via this script (requires Slack app config update)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CURRENT="$REPO_ROOT/slack-app-manifest.json"
SNAPSHOT="$REPO_ROOT/slack-app-manifest.prev.json"

DRY_RUN=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$SNAPSHOT" ]]; then
  echo "ERROR: snapshot not found: $SNAPSHOT" >&2
  echo "Cannot rollback. Check docs/ops/rollback-z-refactor.md for manual recovery." >&2
  exit 1
fi

if [[ ! -f "$CURRENT" ]]; then
  echo "ERROR: current manifest not found: $CURRENT" >&2
  exit 1
fi

if cmp -s "$CURRENT" "$SNAPSHOT"; then
  echo "manifest already matches snapshot — nothing to do."
  exit 0
fi

echo "=== Rollback plan ==="
echo "From: $CURRENT"
echo "To:   $SNAPSHOT"
echo
echo "=== Diff (current → snapshot) ==="
diff -u "$CURRENT" "$SNAPSHOT" || true
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "--dry-run specified, no files written."
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Apply rollback? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

BACKUP="$CURRENT.rollback-backup-$(date +%Y%m%d-%H%M%S)"
cp "$CURRENT" "$BACKUP"
cp "$SNAPSHOT" "$CURRENT"

echo
echo "=== Rollback complete ==="
echo "current manifest restored from snapshot."
echo "previous manifest saved to: $BACKUP"
echo
echo "NEXT STEPS (operator action required):"
echo "  1. Review $CURRENT"
echo "  2. Upload the restored manifest to Slack:"
echo "     https://api.slack.com/apps → your app → App Manifest → paste → save"
echo "  3. (Optional) Also set SOMA_ENABLE_LEGACY_SLASH=true on running instances"
echo "     to immediately disable /z prefix handling in the bot (Tier 1)."
echo "  4. Commit the rollback: git add slack-app-manifest.json && git commit -m 'rollback(slack): restore pre-/z manifest'"
