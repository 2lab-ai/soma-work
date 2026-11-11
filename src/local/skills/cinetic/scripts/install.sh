#!/usr/bin/env bash
# Fetch the upstream cinetic skill (Leonxlnx/cinetic, MIT) at the pinned commit and print its skill root.
# The checkout lives outside the plugin (CINETIC_HOME, default ~/.cache/cinetic): the skill is 18 MB of scripts,
# references and a Remotion starter, so it is pinned here, not vendored. Re-running is cheap: it only fetches when the
# pinned commit is not there yet. Override the pin for a trial with CINETIC_PIN=<sha>.
set -euo pipefail
PIN="${CINETIC_PIN:-f4bbfc844877891fe92279d47b7874fb44d485ae}"
REPO="${CINETIC_REPO:-https://github.com/Leonxlnx/cinetic.git}"
DIR="${CINETIC_HOME:-$HOME/.cache/cinetic}"
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --filter=blob:none --no-checkout "$REPO" "$DIR"
fi
if ! git -C "$DIR" cat-file -e "${PIN}^{commit}" 2>/dev/null; then
  git -C "$DIR" fetch --quiet origin
fi
git -C "$DIR" -c advice.detachedHead=false checkout --quiet "$PIN"
ROOT="$DIR/skills/cinetic"
[ -f "$ROOT/SKILL.md" ] || { echo "cinetic: $ROOT/SKILL.md missing at $PIN" >&2; exit 1; }
echo "$ROOT"
