#!/bin/bash
# version-bump.sh — Find last version tag, bump patch, generate AI release notes, write version.json
#
# Usage: ./scripts/version-bump.sh [branch]
#   branch: 'main' or 'dev' (default: current git branch)
#
# Version scheme:
#   Base tags:   v0.2, v0.3 (manual milestones)
#   Main deploy: v0.2.1, v0.2.2, ... (auto patch bump from latest non-dev tag)
#   Dev deploy:  v0.2.1-dev, v0.2.2-dev, ... (auto patch bump, -dev suffix)
#
# Outputs: dist/version.json with version metadata and release notes
# Side effect: creates and pushes a new git tag (vX.Y.Z or vX.Y.Z-dev)

set -euo pipefail

BRANCH="${1:-$(git branch --show-current)}"
DIST_DIR="dist"

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
#   1. Find branch-specific tags first (dev → *-dev, main → non-dev)
#   2. Also find the latest base/release tag as fallback
#   3. Pick whichever is newer (higher version)

find_latest_tag() {
  local branch="$1"
  local branch_tag=""
  local base_tag=""

  if [[ "$branch" == "dev" ]]; then
    # Dev: look for -dev tags first
    branch_tag=$(git tag -l 'v*-dev' --sort=-version:refname | head -1)
  else
    # Main: look for non-dev tags (exclude -dev suffix)
    branch_tag=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-dev$' | head -1)
  fi

  # Also find the latest base release tag (no -dev, used as milestone)
  base_tag=$(git tag -l 'v*' --sort=-version:refname | grep -v '\-dev$' | head -1)

  # Compare and pick the higher version
  if [[ -z "$branch_tag" && -z "$base_tag" ]]; then
    echo ""
    return
  fi

  if [[ -z "$branch_tag" ]]; then
    echo "$base_tag"
    return
  fi

  if [[ -z "$base_tag" ]]; then
    echo "$branch_tag"
    return
  fi

  # Normalize both and compare
  local branch_ver base_ver
  branch_ver=$(normalize_version "$branch_tag")
  base_ver=$(normalize_version "$base_tag")

  # Use sort -V to find the higher version
  local higher
  higher=$(printf '%s\n%s\n' "$branch_ver" "$base_ver" | sort -V | tail -1)

  if [[ "$higher" == "$branch_ver" ]]; then
    echo "$branch_tag"
  else
    echo "$base_tag"
  fi
}

LATEST_TAG=$(find_latest_tag "$BRANCH")

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
if [[ "$BRANCH" == "dev" ]]; then
  NEW_TAG="v${NEW_VERSION}-dev"
else
  NEW_TAG="v${NEW_VERSION}"
fi
echo "[version-bump] New version: $NEW_TAG"

# --- Collect commit metadata ---

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_HASH_SHORT=$(git rev-parse --short HEAD)
COMMIT_TIME=$(git log -1 --format='%aI' HEAD)
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- Generate release notes ---

# Git log between versions (or last 20 commits if no previous tag)
if [[ -n "$PREV_TAG" ]]; then
  GIT_LOG=$(git log "${PREV_TAG}..HEAD" --oneline --no-merges 2>/dev/null || echo "")
  GIT_DIFF_STAT=$(git diff "${PREV_TAG}..HEAD" --stat 2>/dev/null || echo "")
else
  GIT_LOG=$(git log --oneline --no-merges -20 2>/dev/null || echo "")
  GIT_DIFF_STAT=$(git diff HEAD~20..HEAD --stat 2>/dev/null || echo "")
fi

RELEASE_NOTES=""

# Try AI-based release notes (Claude CLI)
if command -v claude &>/dev/null && [[ -n "$GIT_LOG" ]]; then
  echo "[version-bump] Generating AI release notes via Claude CLI..."

  AI_PROMPT="Generate a concise Korean release note for a Slack bot deployment.
Version: ${PREV_VERSION} → ${NEW_VERSION}

Git commits:
${GIT_LOG}

File changes:
${GIT_DIFF_STAT}

Rules:
- Use bullet points with emoji prefixes (🐛 fix, ✨ feat, ♻️ refactor, 📝 docs, 🔧 chore)
- Group by type
- Each item: 1 line, Korean
- Max 10 items
- No markdown headers, just bullets
- Output only the bullet list, nothing else"

  RELEASE_NOTES=$(claude --print -m haiku "$AI_PROMPT" 2>/dev/null || echo "")
fi

# Fallback: simple git log
if [[ -z "$RELEASE_NOTES" ]]; then
  echo "[version-bump] Using git log for release notes"
  if [[ -n "$GIT_LOG" ]]; then
    RELEASE_NOTES=$(echo "$GIT_LOG" | head -15 | sed 's/^/• /')
  else
    RELEASE_NOTES="• Initial release"
  fi
fi

# --- Write version.json ---

mkdir -p "$DIST_DIR"

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
  buildTime: process.argv[9],
  releaseNotes: process.argv[10],
};
process.stdout.write(JSON.stringify(data, null, 2) + '\n');
" "$NEW_VERSION" "$PREV_VERSION" "$NEW_TAG" "${PREV_TAG:-none}" \
  "$COMMIT_HASH" "$COMMIT_HASH_SHORT" "$COMMIT_TIME" "$BRANCH" \
  "$BUILD_TIME" "$RELEASE_NOTES" > "$DIST_DIR/version.json"

echo "[version-bump] Wrote $DIST_DIR/version.json"
cat "$DIST_DIR/version.json"

# --- Create git tag ---

git tag -a "$NEW_TAG" -m "Release $NEW_TAG" HEAD
echo "[version-bump] Created tag: $NEW_TAG"

# Push tag (uses default git credentials from checkout action)
git push origin "$NEW_TAG" 2>/dev/null || {
  echo "[version-bump] Warning: failed to push tag (non-fatal)"
}

echo "[version-bump] Done: $NEW_TAG"
