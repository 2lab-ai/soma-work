#!/usr/bin/env bash
#
# lean-verify.sh — rebuild the Lean proofs, audit what they rest on, and
# regenerate the conformance vectors. See verification/README.md.
#
#   bash scripts/verification/lean-verify.sh           regenerate; leave any diff for review
#   bash scripts/verification/lean-verify.sh --check   CI: also fail when verification/vectors
#                                                      differs from what is committed
#
# Stages, each fail-closed:
#
#   0. extract       Each scripts/verification/extract-*.cjs writes the generated Lean data
#                    a module proves things about (gitignored; rebuilt from the checkout on
#                    every run). It runs first, so every stage below covers its output.
#   1. source gate   No escape hatch in SomaVerify/**/*.lean: a hole left in a proof, a
#                    user-declared axiom, compiled evaluation standing in for the kernel
#                    (`native_decide`, `decide +native`), or compiled code standing in for
#                    the definition the proofs are about (`implemented_by`, `extern`) — the
#                    one the axiom audit below cannot see, and the one that would let a
#                    vector disagree with a proved definition. Offending lines are printed.
#   2. lake build    Every module, by the lakefile's glob. "Nothing to build" is a failure,
#                    not a pass.
#   3. axiom audit   Every declaration in every module depends on no axiom beyond propext,
#                    Classical.choice and Quot.sound. Generators each define a top-level
#                    `main`, so two of them cannot be imported into one file: the other
#                    modules are audited together and each generator on its own, which
#                    audits every module exactly once.
#   4. vectors       Each SomaVerify/<Dir>/Vectors.lean (Dir other than Support, which holds
#                    the shared helpers) is run and its stdout written to
#                    verification/vectors/<dir-in-kebab-case>.json. Warnings are errors
#                    here: `lean --run` prints them on stdout, i.e. into the vector file.
#   5. drift         (--check only) git reports no modified or untracked file under
#                    verification/vectors.
#
# Discovery is by glob throughout: adding a module needs no edit to this script, the
# lakefile, or a root import file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEAN_ROOT="$REPO_ROOT/verification/lean"
VECTORS_DIR="$REPO_ROOT/verification/vectors"

# Matched per line against SomaVerify/**/*.lean; keep these words out of comments too.
FORBIDDEN='\bsorry\b|\badmit\b|^[[:space:]]*axiom[[:space:]]|native_decide|decide[[:space:]]*\+native|implemented_by|\[extern'

# Filled by discover(); bash 3.2 compatible (no mapfile, guarded empty expansions).
MODULES=()      # every module, e.g. SomaVerify.Support.Json
GENERATORS=()   # generator files, e.g. SomaVerify/JsString/Vectors.lean
NAMES=()        # vector names, parallel to GENERATORS, e.g. js-string
THEOREMS=0      # summed over the audit files

die() {
  echo "lean-verify: $*" >&2
  exit 1
}

stage() {
  echo
  echo "==> $*"
}

# SomaVerify/Support/Json.lean -> SomaVerify.Support.Json
module_of() {
  local path="${1%.lean}"
  printf '%s\n' "${path//\//.}"
}

# JsString -> js-string, CliArgs -> cli-args, JSONPath -> json-path
kebab() {
  printf '%s' "$1" | sed -E 's/([A-Z]+)([A-Z][a-z])/\1-\2/g; s/([a-z0-9])([A-Z])/\1-\2/g' | tr '[:upper:]' '[:lower:]'
}

extract() {
  stage "extract"
  local script count=0
  for script in "$REPO_ROOT"/scripts/verification/extract-*.cjs; do
    [ -e "$script" ] || continue
    node "$script" || die "extract: ${script#"$REPO_ROOT"/} failed"
    count=$((count + 1))
  done
  echo "extract: $count extractor(s)"
}

discover() {
  local file dir name seen
  while IFS= read -r file; do
    MODULES+=("$(module_of "$file")")
  done < <(find SomaVerify -type f -name '*.lean' | LC_ALL=C sort)
  [ "${#MODULES[@]}" -gt 0 ] || die "no Lean modules under verification/lean/SomaVerify"

  while IFS= read -r file; do
    dir="${file#SomaVerify/}"
    dir="${dir%/Vectors.lean}"
    [ "$dir" != "Support" ] || continue
    name="$(kebab "$dir")"
    for seen in ${NAMES[@]+"${NAMES[@]}"}; do
      [ "$seen" != "$name" ] || die "two generators map to verification/vectors/$name.json"
    done
    GENERATORS+=("$file")
    NAMES+=("$name")
  done < <(find SomaVerify -mindepth 2 -maxdepth 2 -type f -name Vectors.lean | LC_ALL=C sort)

  echo "modules: ${#MODULES[@]}, vector generators: ${#GENERATORS[@]}"
}

source_gate() {
  stage "source gate"
  local hits status=0
  hits="$(grep -rnE --include='*.lean' -e "$FORBIDDEN" SomaVerify)" || status=$?
  case "$status" in
    0)
      printf '%s\n' "$hits" >&2
      die "source gate: forbidden construct in verification/lean/SomaVerify (lines above)"
      ;;
    1) echo "source gate: clean (${#MODULES[@]} files)" ;;
    *) die "source gate: grep failed with status $status" ;;
  esac
}

lake_build() {
  stage "lake build"
  local log status=0
  log="$(lake build 2>&1)" || status=$?
  printf '%s\n' "$log"
  [ "$status" -eq 0 ] || die "lake build failed (exit $status)"
  # Pattern matching, not `printf | grep -q`: under pipefail an early grep exit
  # can SIGPIPE the printf and turn a match into a miss on a long log.
  case "$log" in
    *"Nothing to build"* | *"no targets specified"*)
      die "lake build built nothing; check defaultTargets in verification/lean/lakefile.toml"
      ;;
    *"declaration uses 'sorry'"*)
      die "lake build reported a declaration using 'sorry'"
      ;;
  esac
}

# write_audit <file> <minimum theorem count> <module>...
#
# The audit covers declarations whose defining module is one of the listed
# modules: selecting by module rather than by namespace also catches a
# declaration made outside the SomaVerify namespace.
write_audit() {
  local file="$1" min="$2" targets="" module
  shift 2
  for module in "$@"; do
    targets="${targets:+$targets, }\`$module"
  done
  {
    echo "-- Generated by scripts/verification/lean-verify.sh on every run; do not edit."
    echo "import Lean"
    for module in "$@"; do
      echo "import $module"
    done
    echo
    echo "open Lean Elab Command"
    echo
    printf 'def auditTargets : List Name := [%s]\n' "$targets"
    printf 'def auditMinTheorems : Nat := %s\n' "$min"
    cat <<'LEAN'

#eval show CommandElabM Unit from do
  let env ← getEnv
  let allowed : List Name := [``propext, ``Classical.choice, ``Quot.sound]
  let mut bad : Array (Name × Name) := #[]
  let mut decls : Nat := 0
  let mut theorems : Nat := 0
  for (n, ci) in env.constants.toList do
    let some idx := env.getModuleIdxFor? n | continue
    unless auditTargets.contains env.header.moduleNames[idx.toNat]! do continue
    decls := decls + 1
    if let .thmInfo _ := ci then
      theorems := theorems + 1
    let axs ← liftCoreM <| Lean.collectAxioms n
    for a in axs do
      unless allowed.contains a do
        bad := bad.push (n, a)
  unless bad.isEmpty do
    throwError m!"forbidden axioms: {bad.toList}"
  if theorems < auditMinTheorems then
    throwError m!"found {theorems} theorems in {auditTargets}; expected at least {auditMinTheorems}"
  logInfo m!"audit ok: {theorems} theorems ({decls} declarations), standard axioms only"
LEAN
  } >"$file"
}

# run_audit <file>
run_audit() {
  local file="$1" out status=0 count
  out="$(lake env lean "$file" 2>&1)" || status=$?
  printf '%s\n' "$out"
  [ "$status" -eq 0 ] || die "axiom audit failed: verification/lean/$file"
  count="$(printf '%s\n' "$out" | sed -nE 's/.*audit ok: ([0-9]+) theorems.*/\1/p')"
  [ -n "$count" ] || die "axiom audit printed no result: verification/lean/$file"
  THEOREMS=$((THEOREMS + count))
}

axiom_audit() {
  stage "axiom audit"
  local module gen audited=0 i
  local rest=()
  for module in "${MODULES[@]}"; do
    local is_generator=0
    for gen in ${GENERATORS[@]+"${GENERATORS[@]}"}; do
      [ "$module" != "$(module_of "$gen")" ] || is_generator=1
    done
    [ "$is_generator" -eq 1 ] || rest+=("$module")
  done

  if [ "${#rest[@]}" -gt 0 ]; then
    write_audit .generated/Audit.lean 1 "${rest[@]}"
    run_audit .generated/Audit.lean
    audited=$((audited + ${#rest[@]}))
  fi
  i=0
  while [ "$i" -lt "${#GENERATORS[@]}" ]; do
    write_audit ".generated/Audit.${NAMES[$i]}.lean" 0 "$(module_of "${GENERATORS[$i]}")"
    run_audit ".generated/Audit.${NAMES[$i]}.lean"
    audited=$((audited + 1))
    i=$((i + 1))
  done

  [ "$audited" -eq "${#MODULES[@]}" ] || die "axiom audit covered $audited of ${#MODULES[@]} modules"
  echo "audit ok: $THEOREMS theorems in ${#MODULES[@]} modules, standard axioms only"
}

generate_vectors() {
  stage "vectors"
  local i gen name tmp err expected status
  mkdir -p "$VECTORS_DIR"
  i=0
  while [ "$i" -lt "${#GENERATORS[@]}" ]; do
    gen="${GENERATORS[$i]}"
    name="${NAMES[$i]}"
    tmp=".generated/$name.json"
    err=".generated/$name.stderr"
    status=0
    lake env lean -DwarningAsError=true --run "$gen" >"$tmp" 2>"$err" || status=$?
    if [ "$status" -ne 0 ]; then
      cat "$tmp" "$err" >&2
      die "vectors: $gen exited with status $status"
    fi
    # The first bytes name the vector file this generator must write (a copied
    # generator that kept its source's name fails here), and the last line
    # closes the document: anything printed around it is not a vector.
    expected="{\"module\":\"$name\","
    if [ "$(head -c "${#expected}" "$tmp")" != "$expected" ]; then
      head -n 3 "$tmp" >&2
      die "vectors: $gen output does not start with $expected"
    fi
    if [ "$(tail -n 1 "$tmp")" != "]}" ]; then
      tail -n 3 "$tmp" >&2
      die "vectors: $gen output does not end with the closing ]}"
    fi
    mv "$tmp" "$VECTORS_DIR/$name.json"
    echo "vectors: $gen -> verification/vectors/$name.json ($(grep -c '' "$VECTORS_DIR/$name.json") lines)"
    i=$((i + 1))
  done

  # A vector file without a generator would never be regenerated, so drift
  # could not be detected on it.
  local file base known
  for file in "$VECTORS_DIR"/*.json; do
    [ -e "$file" ] || continue
    base="$(basename "$file" .json)"
    known=0
    for name in ${NAMES[@]+"${NAMES[@]}"}; do
      [ "$name" != "$base" ] || known=1
    done
    [ "$known" -eq 1 ] || die "vectors: verification/vectors/$base.json has no generator under SomaVerify/"
  done
}

drift_check() {
  stage "drift check"
  local changes
  changes="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all -- verification/vectors)"
  if [ -n "$changes" ]; then
    printf '%s\n' "$changes" >&2
    git -C "$REPO_ROOT" --no-pager diff --stat -- verification/vectors >&2
    die "drift: verification/vectors differs from the commit; run 'npm run verify:lean' and commit the result"
  fi
  echo "drift: verification/vectors matches the commit"
}

main() {
  local check=0
  case "$#:${1:-}" in
    0:) ;;
    1:--check) check=1 ;;
    *)
      echo "usage: $0 [--check]" >&2
      exit 2
      ;;
  esac

  export PATH="/opt/homebrew/bin:$HOME/.elan/bin:$PATH"
  command -v lake >/dev/null 2>&1 ||
    die "lake not found; install elan (the toolchain is pinned by verification/lean/lean-toolchain)"

  cd "$LEAN_ROOT"
  rm -rf .generated
  mkdir .generated

  extract
  discover
  source_gate
  lake_build
  axiom_audit
  generate_vectors
  if [ "$check" -eq 1 ]; then
    drift_check
  fi
  echo
  echo "lean-verify: ok"
}

main "$@"
