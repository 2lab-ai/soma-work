#!/bin/bash
# version-bump.sh — Find last version tag, bump patch, write release notes (PR titles from main's first-parent chain) and version.json
#
# Usage: ./scripts/version-bump.sh [git-ref]
#   git-ref: 'main' or 'deploy/prod' (default: current git branch)
#
# Version scheme:
#   Base tags:   v0.2, v0.3 (manual milestones)
#   deploy/prod: v0.2.1, v0.2.2, ... (auto patch bump from latest non-dev tag)
#   main:        v0.2.1-dev, v0.2.2-dev, ... (auto patch bump, -dev suffix)
#
# Outputs: dist/version.json with version metadata and release notes, dist/release-history.json (main's recent PRs)
# Side effect: creates and pushes a new git tag (vX.Y.Z or vX.Y.Z-dev). A dev tag whose push is refused is dropped and
# the deploy goes on (the next dev deploy reuses the number); a production tag whose push is refused stops the deploy.

set -euo pipefail

GIT_REF="${1:-$(git branch --show-current)}"
DIST_DIR="dist"

resolve_release_track() {
  local git_ref="$1"

  case "$git_ref" in
    main|dev)
      echo "dev"
      ;;
    deploy/prod)
      echo "main"
      ;;
    *)
      echo "main"
      ;;
  esac
}

RELEASE_TRACK="$(resolve_release_track "$GIT_REF")"

# --- Ensure tags are synced (critical for self-hosted runners) ---

git fetch --tags --prune-tags --force 2>/dev/null || {
  echo "[version-bump] Warning: failed to fetch tags (using local only)"
}

# --- Semver helpers ---

normalize_version() {
  local ver="$1"
  ver="${ver#v}"  # strip leading 'v'
  local parts
  IFS='.' read -ra parts <<< "$ver"
  local major="${parts[0]:-0}"
  local minor="${parts[1]:-0}"
  local patch="${parts[2]:-0}"
  # Strip pre-release suffix (e.g., "0-dev" → "0")
  patch="${patch%%-*}"
  patch="${patch:-0}"
  echo "${major}.${minor}.${patch}"
}

bump_patch() {
  local ver="$1"
  IFS='.' read -ra parts <<< "$ver"
  local major="${parts[0]}"
  local minor="${parts[1]}"
  local patch="${parts[2]}"
  echo "${major}.${minor}.$((patch + 1))"
}

# --- Find latest version tag (branch-aware) ---
#
# Strategy:
#   1. Find release-track-specific tags first (dev → *-dev, main → non-dev)
#   2. Also find the latest base/release tag as fallback
#   3. Pick whichever is newer (higher version)

find_latest_tag() {
  local release_track="$1"
  local track_tag=""
  local base_tag=""

  if [[ "$release_track" == "dev" ]]; then
    # Dev: look for -dev tags first
    track_tag=$(git tag -l 'v*-dev' --sort=-version:refname | head -1)
  else
    # Main: look for non-dev tags (exclude -dev suffix)
    track_tag=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-dev$' | head -1)
  fi

  # Also find the latest base release tag (no -dev, used as milestone)
  base_tag=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-dev$' | head -1)

  # Compare and pick the higher version
  if [[ -z "$track_tag" && -z "$base_tag" ]]; then
    echo ""
    return
  fi

  if [[ -z "$track_tag" ]]; then
    echo "$base_tag"
    return
  fi

  if [[ -z "$base_tag" ]]; then
    echo "$track_tag"
    return
  fi

  # Normalize both and compare
  local track_ver base_ver
  track_ver=$(normalize_version "$track_tag")
  base_ver=$(normalize_version "$base_tag")

  # Use sort -V to find the higher version
  local higher
  higher=$(printf '%s\n%s\n' "$track_ver" "$base_ver" | sort -V | tail -1)

  if [[ "$higher" == "$track_ver" ]]; then
    echo "$track_tag"
  else
    echo "$base_tag"
  fi
}

LATEST_TAG=$(find_latest_tag "$RELEASE_TRACK")

if [[ -z "$LATEST_TAG" ]]; then
  echo "[version-bump] No existing tags found, starting at v0.1.0"
  PREV_VERSION="0.0.0"
  NEW_VERSION="0.1.0"
  PREV_TAG=""
else
  PREV_VERSION=$(normalize_version "$LATEST_TAG")
  NEW_VERSION=$(bump_patch "$PREV_VERSION")
  PREV_TAG="$LATEST_TAG"
  echo "[version-bump] Latest tag: $LATEST_TAG (normalized: $PREV_VERSION)"
fi

# Dev deploys get -dev suffix to avoid tag collision with main
if [[ "$RELEASE_TRACK" == "dev" ]]; then
  NEW_TAG="v${NEW_VERSION}-dev"
else
  NEW_TAG="v${NEW_VERSION}"
fi
echo "[version-bump] New version: $NEW_TAG"

# --- Detect rollback ---
# Rollback = HEAD is an ancestor of the previous tag (we went backwards)

IS_ROLLBACK="false"
ROLLBACK_TARGET=""
ROLLBACK_TARGET_VERSION=""

if [[ -n "$PREV_TAG" ]]; then
  PREV_TAG_COMMIT=$(git rev-parse "${PREV_TAG}^{commit}" 2>/dev/null || echo "")
  HEAD_COMMIT=$(git rev-parse HEAD)

  if [[ -n "$PREV_TAG_COMMIT" && "$PREV_TAG_COMMIT" != "$HEAD_COMMIT" ]]; then
    if git merge-base --is-ancestor HEAD "$PREV_TAG" 2>/dev/null; then
      IS_ROLLBACK="true"
      echo "[version-bump] Rollback detected: HEAD is behind $PREV_TAG"

      # Find which tag HEAD matches (branch-aware)
      if [[ "$RELEASE_TRACK" == "dev" ]]; then
        ROLLBACK_TARGET=$(git tag --points-at HEAD | grep '\-dev$' | head -1)
      else
        ROLLBACK_TARGET=$(git tag --points-at HEAD | grep -v '\-dev$' | head -1)
      fi
      [[ -z "$ROLLBACK_TARGET" ]] && ROLLBACK_TARGET=$(git tag --points-at HEAD | head -1)
      [[ -z "$ROLLBACK_TARGET" ]] && ROLLBACK_TARGET=$(git describe --tags --abbrev=0 HEAD 2>/dev/null || echo "")

      if [[ -n "$ROLLBACK_TARGET" ]]; then
        ROLLBACK_TARGET_VERSION=$(normalize_version "$ROLLBACK_TARGET")
      fi
      echo "[version-bump] Rollback target: ${ROLLBACK_TARGET:-unknown} (${ROLLBACK_TARGET_VERSION:-?})"
    fi
  fi
fi

# --- Collect commit metadata ---

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_HASH_SHORT=$(git rev-parse --short HEAD)
COMMIT_TIME=$(git log -1 --format='%aI' HEAD)
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- Generate release notes ---
#
# One line per PR merged to main since the last deploy of a DIFFERENT commit (scripts/release-notes.mjs walks the
# first-parent chain). Dev tags are global — every deploy to any host makes one — so the newest tag often names this
# very commit (one host got it an hour ago, this run deploys it to another). Its range would be empty, and the notes
# used to fall to "Initial release". Walk back to the newest tag on another commit instead.
#
# These are the bundle's default notes. Each host announces its own range at startup (packages/slack/src/
# release-notes.ts): from the version.json this deploy replaced there (scripts/deploy/sync-bundle.sh keeps it as
# dist/previous-version.json) to this commit, out of dist/release-history.json written here.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIST_DIR"
node "$SCRIPT_DIR/release-notes.mjs" history "$DIST_DIR/release-history.json" 500

NOTES_BASE=""
if [[ -n "$PREV_TAG" ]]; then
  HEAD_COMMIT=$(git rev-parse HEAD)
  if [[ "$RELEASE_TRACK" == "dev" ]]; then
    TRACK_TAGS=$(git tag -l 'v*-dev' --sort=-version:refname)
  else
    TRACK_TAGS=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-dev$' || true)
  fi
  for candidate in $PREV_TAG $TRACK_TAGS; do
    candidate_commit=$(git rev-parse "${candidate}^{commit}" 2>/dev/null || echo "")
    [[ -z "$candidate_commit" || "$candidate_commit" == "$HEAD_COMMIT" ]] && continue
    if git merge-base --is-ancestor "$candidate_commit" HEAD 2>/dev/null; then
      NOTES_BASE="$candidate"
      break
    fi
  done
fi

if [[ -n "$NOTES_BASE" ]]; then
  echo "[version-bump] Release notes: ${NOTES_BASE}..HEAD (first-parent)"
  RELEASE_NOTES=$(node "$SCRIPT_DIR/release-notes.mjs" notes "$NOTES_BASE" || echo "")
  [[ -z "$RELEASE_NOTES" ]] && RELEASE_NOTES="• 코드 변경 없음 — ${NOTES_BASE}와 같은 내용"
elif [[ -n "$PREV_TAG" ]]; then
  RELEASE_NOTES="• 코드 변경 없음 — ${PREV_TAG}와 같은 커밋 재배포"
else
  RELEASE_NOTES="• 첫 배포"
fi

# Override release notes for rollback
if [[ "$IS_ROLLBACK" == "true" ]]; then
  if [[ -n "$ROLLBACK_TARGET" ]]; then
    RELEASE_NOTES="• ⏪ ${PREV_TAG}에서 ${ROLLBACK_TARGET}(으)로 롤백"
  else
    RELEASE_NOTES="• ⏪ ${PREV_TAG}에서 이전 버전으로 롤백"
  fi
fi

# --- Write version.json ---

# Use node to safely generate JSON (handles escaping)
node -e "
const data = {
  version: process.argv[1],
  previousVersion: process.argv[2],
  tag: process.argv[3],
  previousTag: process.argv[4],
  commitHash: process.argv[5],
  commitHashShort: process.argv[6],
  commitTime: process.argv[7],
  branch: process.argv[8],
  releaseTrack: process.argv[9],
  buildTime: process.argv[10],
  releaseNotes: process.argv[11],
  isRollback: process.argv[12] === 'true',
  rollbackTargetTag: process.argv[13] || null,
  rollbackTargetVersion: process.argv[14] || null,
};
process.stdout.write(JSON.stringify(data, null, 2) + '\n');
" "$NEW_VERSION" "$PREV_VERSION" "$NEW_TAG" "${PREV_TAG:-none}" \
  "$COMMIT_HASH" "$COMMIT_HASH_SHORT" "$COMMIT_TIME" "$GIT_REF" \
  "$RELEASE_TRACK" "$BUILD_TIME" "$RELEASE_NOTES" "$IS_ROLLBACK" "$ROLLBACK_TARGET" "$ROLLBACK_TARGET_VERSION" > "$DIST_DIR/version.json"

echo "[version-bump] Wrote $DIST_DIR/version.json"
cat "$DIST_DIR/version.json"

# --- Create git tag ---

git tag -a "$NEW_TAG" -m "Release $NEW_TAG" HEAD
echo "[version-bump] Created tag: $NEW_TAG"

# Push tag (uses default git credentials from checkout action)
if ! git push origin "$NEW_TAG"; then
  if [[ "$RELEASE_TRACK" == "dev" ]]; then
    # A dev deploy goes on without its tag: dist/version.json above already names the version, and the next dev
    # deploy numbers from the last tag that did land (this number again). A refused tag push — the workflow token
    # lost its write on the runner side (2026-11-16: 403 to github-actions[bot] while the token listed contents:
    # write) — must not stop every dev deploy. A production deploy still stops: its versions are the release record.
    echo "[version-bump] WARNING: failed to push tag $NEW_TAG — dev deploy continues; the next dev deploy reuses this number."
    git tag -d "$NEW_TAG" >/dev/null 2>&1 || true
  else
    echo "[version-bump] ERROR: failed to push tag $NEW_TAG — version will not persist!"
    echo "[version-bump] Next deploy will re-create the same version number."
    exit 1
  fi
fi

echo "[version-bump] Done: $NEW_TAG"
