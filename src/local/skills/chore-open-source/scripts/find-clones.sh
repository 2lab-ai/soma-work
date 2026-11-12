#!/usr/bin/env bash
# find-clones.sh OWNER/REPO [ROOT...] — every clone of OWNER/REPO under the roots (default: $HOME
# and the temp folders, 4 levels deep), each checked with `migrate-clone.py --check`.
# Prints one line per clone and a total; exit 1 when any clone still has the old history or a
# pattern in its local-only commits. Shallow and single-branch clones are covered.
set -uo pipefail
SLUG=${1:?usage: find-clones.sh OWNER/REPO [ROOT...]}
case $SLUG in */*) ;; *) echo "find-clones.sh: expected OWNER/REPO, got '$SLUG'" >&2; exit 2;; esac
: "${CHOS_WORK:?set CHOS_WORK to this run folder}"
shift
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
[ $# -gt 0 ] || set -- "$HOME" "${TMPDIR:-/tmp}" /tmp
bad=0 n=0
while IFS= read -r g; do
  d=${g%/.git}
  u=$(git -C "$d" config --get remote.origin.url 2>/dev/null) || continue
  case "$u" in *"$SLUG" | *"$SLUG".git | *"$SLUG"/) ;; *) continue;; esac
  n=$((n + 1))
  if out=$(python3 -I "$SCRIPTS/migrate-clone.py" "$SLUG" "$d" --check 2>&1); then
    echo "clean  $d"
  else
    bad=$((bad + 1)); echo "OLD    $d"; printf '%s\n' "$out" | sed 's/^/       /' | head -6
  fi
done < <(for root in "$@"; do find "$root" -maxdepth 4 -name .git -type d -not -path '*/Library/*' 2>/dev/null; done | sort -u)
echo "clones of $SLUG: $n, still on the old history or with pattern hits: $bad"
[ "$bad" -eq 0 ]
