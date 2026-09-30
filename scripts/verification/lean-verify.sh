#!/usr/bin/env bash
#
# lean-verify.sh — rebuild the Lean proofs, audit every declaration, re-check them in the
# kernel, and regenerate the conformance vectors. See verification/README.md.
#
#   bash scripts/verification/lean-verify.sh             regenerate; leave any diff for review
#   bash scripts/verification/lean-verify.sh --check     CI: also fail when verification/vectors
#                                                        differs from what is committed
#   bash scripts/verification/lean-verify.sh --selftest  plant each forbidden construct in a
#                                                        scratch copy; each must be rejected
#
# Stages, each fail-closed:
#
#   1. source gate        Textual and fail-fast: no escape hatch spelled out in the code of
#                         SomaVerify/**/*.lean (FORBIDDEN below; comments and string and char
#                         literals are skipped, so prose may use any word), and no invisible or
#                         non-ASCII white-space character anywhere, since those make source say
#                         something other than what it shows.
#   2. lake build         Every module, by the lakefile's glob. "Nothing to build" is a failure.
#   3. declaration audit  Per declaration, however it was spelled:
#                         - no axiom beyond propext, Classical.choice and Quot.sound;
#                         - nothing extern, implemented_by, unsafe or opaque (a partial def
#                           compiles to an opaque constant): each lets the compiled code that
#                           produces the vectors differ from the definition the proofs are about;
#                         - no hand-written `f._unsafe_rec`: the code generator runs a declaration
#                           of that name in place of `f` (Lean.Compiler.LCNF.getDeclInfo?); the
#                           ones Lean generates for recursive definitions are marked partial;
#                         - imports from Init and SomaVerify only: with Lean's metaprogramming
#                           API a module could add declarations the kernel never checked.
#   4. kernel replay      leanchecker, shipped with the toolchain, re-checks every declaration of
#                         every module in the kernel, reading the .olean files.
#   5. vectors            Each SomaVerify/<Dir>/Vectors.lean (Dir other than Support) is run and
#                         its stdout written to verification/vectors/<dir-in-kebab-case>.json.
#                         Warnings are errors: `lean --run` prints them on stdout.
#   6. drift              (--check only) git reports no change under verification/vectors.
#
# Discovery is by glob throughout: adding a module needs no edit to this script, the lakefile,
# or a root import file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEAN_ROOT="$REPO_ROOT/verification/lean"
VECTORS_DIR="$REPO_ROOT/verification/vectors"

# A Perl regex matched per line against the code of SomaVerify/**/*.lean, with comments and
# string and char literals blanked out by lean_code_scan. The declaration audit and the kernel
# replay do not rely on it (--selftest shows each construct is caught without it); it fails fast
# and names the line. In code, `sorry`, `axiom`, `partial`, `unsafe` and `opaque` are keywords,
# never identifiers; `extern` and `implemented_by` are attribute names. `native` and `admit` can
# be ordinary identifiers (a model may well have a `native` field), so only their escape-hatch
# forms are matched: `native_decide`, `+native`, `decide (native := ..)`,
# `decide (config := {native := ..})`, and `admit` in tactic position. `opaque` is matched as a
# declaration only, since a constructor may be named `opaque`.
FORBIDDEN='\bsorry\b|(?:^|\bby\b|\btry\b|\ball_goals\b|\bany_goals\b|\brepeat\b|\bfocus\b|;|<;>|\x{B7}|\||=>|\()\s*admit\b|\baxiom\b|native_decide|\+native\b|\bdecide\s*\(\s*(?:native\s*:=|config\s*:=[^)]*\bnative\b)|\bimplemented_by\b|\bextern\b|\bpartial\b|\bunsafe\b|(?:^|\bin\b)\s*(?:(?:@\[[^\]]*\]|private|protected|noncomputable|nonrec|unsafe|partial)\s+)*opaque\b|_unsafe_rec|\bskipKernelTC\b'

# Layer switches, all on except inside --selftest, which turns layers off to show that each
# construct is caught by the declaration audit or the kernel alone.
TEXTUAL=1
AUDIT=1
REPLAY=1

STAGE=setup
MODULES=()      # every module, e.g. SomaVerify.Support.Json
FILES=()        # the same modules as paths, e.g. SomaVerify/Support/Json.lean
GENERATORS=()   # generator files, e.g. SomaVerify/JsString/Vectors.lean
NAMES=()        # vector names, parallel to GENERATORS, e.g. js-string
THEOREMS=0      # theorem declarations, summed over the audit files
HANDWRITTEN=0   # theorem declarations written in the sources

die() {
  echo "lean-verify: [$STAGE] $*" >&2
  exit 1
}

stage() {
  STAGE="$1"
  echo
  echo "==> $1"
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

discover() {
  local file dir name seen
  while IFS= read -r file; do
    FILES+=("$file")
    MODULES+=("$(module_of "$file")")
  done < <(find SomaVerify -type f -name '*.lean' | LC_ALL=C sort)
  [ "${#MODULES[@]}" -gt 0 ] || die "no Lean modules under SomaVerify/"

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

# Prints file:line: U+XXXX for every line holding a control character other than LF, or an
# invisible or non-ASCII white-space character. Visible non-ASCII (math notation) is fine.
invisible_characters() {
  perl -CSD -ne '
    my @found = /([\x{0}-\x{9}\x{B}-\x{1F}\x{7F}-\x{A0}\x{AD}\x{34F}\x{115F}\x{1160}\x{1680}\x{180E}\x{2000}-\x{200F}\x{2028}-\x{202F}\x{205F}-\x{206F}\x{3000}\x{3164}\x{FE00}-\x{FE0F}\x{FEFF}\x{FFA0}\x{FFF9}-\x{FFFB}\x{E0000}-\x{E007F}\x{E0100}-\x{E01EF}])/g;
    printf "%s:%d: %s\n", $ARGV, $., join(" ", map { sprintf "U+%04X", ord } @found) if @found;
    close ARGV if eof;
  ' "$@"
}

# lean_code_scan forbidden <perl regex> <file>...   prints file:line: <source line> for every
#                                                   line whose code matches the regex
# lean_code_scan code <file>...                     prints the code of the files
#
# "Code" is the source with comment text and string and char literal text blanked out, newlines
# kept so line numbers hold. The lexer follows Lean's: nested /- -/ comments (doc comments are
# comments), -- to end of line, strings with escapes, raw strings r"..." and r#"..."#, char
# literals (a '"' opens no string; a prime inside an identifier opens no char), guillemet names
# (whatever they hold), and interpolated strings: after `!` (s!"..", s! ".."), text between
# braces is code, so nothing hides there.
lean_code_scan() {
  perl -CS - "$@" <<'PERL'
use strict;
use warnings;

my ($src, $code);

sub blank { my $text = shift; $text =~ tr/\n/ /c; return $text }

sub span_from { my $start = shift; return substr $src, $start, pos($src) - $start }

# Code until end of input, or until the brace that closes an interpolation.
sub lex_code {
  my ($in_braces) = @_;
  my $depth = 0;
  while (pos($src) < length $src) {
    my $start = pos($src);
    if ($src =~ /\G\/-/gc) {
      my $open = 1;
      while ($open && pos($src) < length $src) {
        if    ($src =~ /\G\/-/gc) { $open++ }
        elsif ($src =~ /\G-\//gc) { $open-- }
        else                      { $src =~ /\G./gcs }
      }
      $code .= blank(span_from($start));
    } elsif ($src =~ /\G--[^\n]*/gc) {
      $code .= blank(span_from($start));
    } elsif ($src =~ /\Gr(#*)"/gc) {
      my $close = '"' . $1;
      $src =~ /\G.*?\Q$close\E/gcs or $src =~ /\G.*/gcs;
      $code .= blank(span_from($start));
    } elsif ($src =~ /\G"/gc) {
      # Interpolated when the code before it ends in `!`, spaces allowed: s!"..", s! "..".
      my $k = length($code) - 1;
      $k-- while $k >= 0 && substr($code, $k, 1) =~ /\s/;
      my $interpolated = $k >= 0 && substr($code, $k, 1) eq '!';
      $code .= ' ';
      lex_string($interpolated);
    } elsif ($src =~ /\G'(?:\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|.)|[^'\\\n])'/gc) {
      $code .= blank(span_from($start));
    } elsif ($src =~ /\G\x{AB}[^\x{BB}]*\x{BB}/gc) {
      # A guillemet name may hold any text, `--` and quotes included: one token.
      $code .= blank(span_from($start));
    } elsif ($src =~ /\G[\p{L}\p{N}_][\p{L}\p{N}_'!?]*/gc) {
      $code .= span_from($start);
    } elsif ($in_braces && $src =~ /\G\{/gc) {
      $depth++;
      $code .= '{';
    } elsif ($in_braces && $src =~ /\G\}/gc) {
      $code .= '}';
      return if $depth-- == 0;
    } else {
      $src =~ /\G(.)/gcs;
      $code .= $1;
    }
  }
}

sub lex_string {
  my ($interpolated) = @_;
  while (pos($src) < length $src) {
    my $start = pos($src);
    if ($src =~ /\G\\./gcs) {
      $code .= blank(span_from($start));
    } elsif ($src =~ /\G"/gc) {
      $code .= ' ';
      return;
    } elsif ($interpolated && $src =~ /\G\{/gc) {
      $code .= '{';
      lex_code(1);
    } else {
      $src =~ /\G(.)/gcs;
      $code .= $1 eq "\n" ? "\n" : ' ';
    }
  }
}

my $mode = shift @ARGV;
my $pattern = $mode eq 'forbidden' ? shift @ARGV : undef;
my $forbidden = defined $pattern ? qr/$pattern/ : undef;
for my $file (@ARGV) {
  open my $fh, '<:encoding(UTF-8)', $file or die "$file: $!\n";
  $src = do { local $/; <$fh> };
  close $fh;
  $code = '';
  pos($src) = 0;
  lex_code(0);
  my @source_lines = split /\n/, $src, -1;
  my @code_lines = split /\n/, $code, -1;
  die "$file: lexer lost track of lines\n" unless @source_lines == @code_lines;
  if ($mode eq 'code') {
    print $code;
    print "\n" if length $code && $code !~ /\n\z/;
    next;
  }
  for my $i (0 .. $#code_lines) {
    print "$file:", $i + 1, ": $source_lines[$i]\n" if $code_lines[$i] =~ $forbidden;
  }
}
PERL
}

source_gate() {
  stage "source gate"
  local hits
  hits="$(lean_code_scan forbidden "$FORBIDDEN" "${FILES[@]}")" || die "the source scan failed"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" >&2
    die "forbidden construct (lines above)"
  fi
  hits="$(invisible_characters "${FILES[@]}")" || die "the invisible-character scan failed"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" >&2
    die "invisible or non-ASCII white-space character (lines above); write it as an escape"
  fi
  echo "source gate: clean (${#FILES[@]} files)"
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
      die "built nothing; check defaultTargets in verification/lean/lakefile.toml"
      ;;
  esac
  if [ "$TEXTUAL" -eq 1 ]; then
    case "$log" in
      *"declaration uses 'sorry'"*) die "a declaration uses 'sorry'" ;;
    esac
  fi
}

# write_audit <file> <minimum theorem count> <module>...
#
# Audits the declarations whose defining module is one of those listed. Selecting by module
# rather than by namespace also covers declarations made outside the SomaVerify namespace.
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

/-- Init has no metaprogramming, and every SomaVerify module is audited itself. -/
def auditImportAllowed (m : Name) : Bool :=
  m.getRoot == `Init || m.getRoot == `SomaVerify

#eval show CommandElabM Unit from do
  let env ← getEnv
  let allowedAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]
  let mut problems : Array String := #[]
  let mut decls : Nat := 0
  let mut theorems : Nat := 0
  -- Each audited module's own declarations, straight from its module data: walking every
  -- constant of every loaded module (all of Lean, for the metaprogramming API) would cost
  -- seconds per run to find the same ones.
  let mut audited : Array ConstantInfo := #[]
  for m in auditTargets do
    match env.getModuleIdx? m with
    | none => problems := problems.push s!"{m}: module not loaded"
    | some idx =>
      let data := env.header.moduleData[idx.toNat]!
      for imp in data.imports do
        unless auditImportAllowed imp.module do
          problems := problems.push
            s!"{m}: imports {imp.module}; only Init and SomaVerify modules may be imported"
      audited := audited ++ data.constants
  for ci in audited do
    let n := ci.name
    decls := decls + 1
    if ci matches .thmInfo _ then
      theorems := theorems + 1
    if isExtern env n then
      problems := problems.push s!"{n}: extern"
    if let some target := Compiler.implementedByAttr.getParam? env n then
      problems := problems.push s!"{n}: implemented_by {target}"
    if ci.isUnsafe then
      problems := problems.push s!"{n}: unsafe"
    if ci matches .opaqueInfo _ then
      problems := problems.push s!"{n}: opaque (a partial def compiles to one)"
    if n matches .str _ "_unsafe_rec" then
      unless ci.isPartial do
        problems := problems.push
          s!"{n}: hand-written; the code generator would run it in place of the declaration it names"
    for a in (← liftCoreM <| collectAxioms n) do
      unless allowedAxioms.contains a do
        problems := problems.push s!"{n}: depends on axiom {a}"
  unless problems.isEmpty do
    throwError m!"declaration audit failed:\n{"\n".intercalate (problems.qsort (· < ·)).toList}"
  if theorems < auditMinTheorems then
    throwError m!"found {theorems} theorems in {auditTargets}; expected at least {auditMinTheorems}"
  logInfo m!"audit ok: {theorems} theorem declarations ({decls} declarations)"
LEAN
  } >"$file"
}

# run_audit <file>
run_audit() {
  local file="$1" out status=0 count
  out="$(lake env lean "$file" 2>&1)" || status=$?
  printf '%s\n' "$out"
  [ "$status" -eq 0 ] || die "verification/lean/$file failed"
  count="$(printf '%s\n' "$out" | sed -nE 's/.*audit ok: ([0-9]+) theorem declarations.*/\1/p')"
  [ -n "$count" ] || die "verification/lean/$file printed no result"
  THEOREMS=$((THEOREMS + count))
}

# Theorem declarations as written: `theorem`/`lemma` at the start of a line, after any
# attribute and modifiers. What the kernel checks also includes lemmas Lean generates.
count_handwritten() {
  local code
  code="$(lean_code_scan code "${FILES[@]}")" || die "the source scan failed"
  printf '%s\n' "$code" |
    grep -cE '^[[:space:]]*(@\[[^]]*\][[:space:]]*)?((private|protected|nonrec)[[:space:]]+)*(theorem|lemma)[[:space:]]' ||
    true
}

declaration_audit() {
  stage "declaration audit"
  local module gen audited=0 i is_generator
  local rest=()
  # Generators each define a top-level `main`, so two of them cannot be imported into one file:
  # the other modules are audited together and each generator on its own.
  for module in "${MODULES[@]}"; do
    is_generator=0
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
  [ "$audited" -eq "${#MODULES[@]}" ] || die "audited $audited of ${#MODULES[@]} modules"

  HANDWRITTEN="$(count_handwritten)"
  echo "hand-written theorems (source): $HANDWRITTEN"
  echo "theorem declarations checked, including lemmas Lean generates: $THEOREMS"
  echo "declaration audit ok: ${#MODULES[@]} modules; standard axioms only; no extern, implemented_by, unsafe, opaque or hand-written _unsafe_rec; imports from Init and SomaVerify only"
}

kernel_replay() {
  stage "kernel replay"
  local out status=0 module
  out="$(lake env leanchecker -v "${MODULES[@]}" 2>&1)" || status=$?
  printf '%s\n' "$out"
  [ "$status" -eq 0 ] || die "leanchecker rejected a module (exit $status)"
  for module in "${MODULES[@]}"; do
    grep -qxF "replaying $module" <<<"$out" || die "leanchecker did not replay $module"
  done
  echo "kernel replay ok: ${#MODULES[@]} modules re-checked from their .olean files"
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
      die "$gen exited with status $status"
    fi
    # The first bytes name the vector file this generator must write (a copied
    # generator that kept its source's name fails here), and the last line
    # closes the document: anything printed around it is not a vector.
    expected="{\"module\":\"$name\","
    if [ "$(head -c "${#expected}" "$tmp")" != "$expected" ]; then
      head -n 3 "$tmp" >&2
      die "$gen output does not start with $expected"
    fi
    if [ "$(tail -n 1 "$tmp")" != "]}" ]; then
      tail -n 3 "$tmp" >&2
      die "$gen output does not end with the closing ]}"
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
    [ "$known" -eq 1 ] || die "verification/vectors/$base.json has no generator under SomaVerify/"
  done
}

drift_check() {
  stage "drift check"
  local changes
  changes="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all -- verification/vectors)"
  if [ -n "$changes" ]; then
    printf '%s\n' "$changes" >&2
    git -C "$REPO_ROOT" --no-pager diff --stat -- verification/vectors >&2
    die "verification/vectors differs from the commit; run 'npm run verify:lean' and commit the result"
  fi
  echo "drift: verification/vectors matches the commit"
}

run_pipeline() {
  cd "$LEAN_ROOT"
  rm -rf .generated
  mkdir .generated
  discover
  if [ "$TEXTUAL" -eq 1 ]; then source_gate; fi
  lake_build
  if [ "$AUDIT" -eq 1 ]; then declaration_audit; fi
  if [ "$REPLAY" -eq 1 ]; then kernel_replay; fi
  generate_vectors
}

# ---------------------------------------------------------------------------------------------
# --selftest: each probe is one module planted in a scratch copy of verification/lean.

SELFTEST_PROBES=(sorry admit axiom axiom-indented axiom-private native_decide decide-native
  decide-native-config decide-native-option implemented_by extern-first-attribute
  extern-second-attribute extern-multiline-attribute partial-def unsafe-def opaque
  unsafe-rec-override forged-theorem module-private-axiom sorry-in-interpolation
  sorry-in-spaced-interpolation sorry-after-literals sorry-after-guillemet-name
  invisible-character clean)

# Expected outcomes, "gate|without textual checks|kernel replay alone": each is "accepted" or
# the stage that rejects the probe, and "-" means the mode is not run.
selftest_expected() {
  case "$1" in
    forged-theorem) echo "source gate|declaration audit|kernel replay" ;;
    invisible-character) echo "source gate|accepted|-" ;;
    clean) echo "accepted|accepted|-" ;;
    *) echo "source gate|declaration audit|-" ;;
  esac
}

probe_source() {
  case "$1" in
    sorry) echo 'theorem SomaVerify.SelfTest.probe : 1 = 2 := by sorry' ;;
    admit) echo 'theorem SomaVerify.SelfTest.probe : 1 = 2 := by admit' ;;
    axiom) echo 'axiom SomaVerify.SelfTest.bogus : 1 = 2' ;;
    axiom-indented)
      printf '%s\n' 'namespace SomaVerify.SelfTest' '  axiom bogus : 1 = 2' 'end SomaVerify.SelfTest'
      ;;
    axiom-private)
      printf '%s\n' 'private axiom bogus : 1 = 2' 'theorem SomaVerify.SelfTest.probe : 1 = 2 := bogus'
      ;;
    native_decide) echo 'theorem SomaVerify.SelfTest.probe : 10 * 10 = 100 := by native_decide' ;;
    decide-native) echo 'theorem SomaVerify.SelfTest.probe : 10 * 10 = 100 := by decide +native' ;;
    decide-native-config)
      echo 'theorem SomaVerify.SelfTest.probe : 10 * 10 = 100 := by decide (config := { native := true })'
      ;;
    decide-native-option)
      echo 'theorem SomaVerify.SelfTest.probe : 10 * 10 = 100 := by decide (native := true)'
      ;;
    module-private-axiom)
      # The module system (a `module` header) splits a module's data by visibility; the audit
      # must still see a private axiom behind a public theorem.
      printf '%s\n' 'module' '' 'private axiom bogus : 1 = 2' \
        'public theorem SomaVerify.SelfTest.probe : 1 = 2 := bogus'
      ;;
    sorry-in-interpolation)
      # Braces in an interpolated string are code: the lexer must not treat them as text.
      echo 'def SomaVerify.SelfTest.msg : String := s!"{(sorry : Nat)}"'
      ;;
    sorry-in-spaced-interpolation)
      echo 'def SomaVerify.SelfTest.msg : String := s! "{(sorry : Nat)}"'
      ;;
    sorry-after-guillemet-name)
      # A guillemet name (UTF-8 C2 AB .. C2 BB) holding a comment marker, then real code.
      printf 'theorem SomaVerify.SelfTest.\302\253a -- b\302\273 : 1 = 2 := by sorry\n'
      ;;
    sorry-after-literals)
      # A quote in a char literal and comment markers in a string, then real code on the
      # same line: a lexer that loses its place here would hide the sorry.
      cat <<'PROBE'
def SomaVerify.SelfTest.q : Char := '"' def SomaVerify.SelfTest.d : String := "-- /-" theorem SomaVerify.SelfTest.probe : 1 = 2 := by sorry
PROBE
      ;;
    implemented_by)
      printf '%s\n' 'def SomaVerify.SelfTest.fast (n : Nat) : Nat := n + 1' \
        '@[implemented_by SomaVerify.SelfTest.fast] def SomaVerify.SelfTest.slow (n : Nat) : Nat := n'
      ;;
    extern-first-attribute)
      echo '@[extern "lean_nat_add"] def SomaVerify.SelfTest.claimed (a b : Nat) : Nat := a'
      ;;
    extern-second-attribute)
      echo '@[noinline, extern "lean_nat_add"] def SomaVerify.SelfTest.claimed (a b : Nat) : Nat := a'
      ;;
    extern-multiline-attribute)
      printf '%s\n' '@[noinline,' '  extern "lean_nat_add"]' \
        'def SomaVerify.SelfTest.claimed (a b : Nat) : Nat := a'
      ;;
    partial-def)
      echo 'partial def SomaVerify.SelfTest.loop (n : Nat) : Nat := SomaVerify.SelfTest.loop (n + 1)'
      ;;
    unsafe-def) echo 'unsafe def SomaVerify.SelfTest.raw (n : Nat) : Nat := n' ;;
    opaque) echo 'opaque SomaVerify.SelfTest.hidden : Nat' ;;
    unsafe-rec-override)
      # Proved to return its argument, compiled to add 100.
      printf '%s\n' 'def SomaVerify.SelfTest.f (n : Nat) : Nat := n' \
        'def SomaVerify.SelfTest.f._unsafe_rec (n : Nat) : Nat := n + 100' \
        'theorem SomaVerify.SelfTest.f_one : SomaVerify.SelfTest.f 1 = 1 := rfl'
      ;;
    forged-theorem)
      # A theorem of False added without the kernel: no axiom, so only the import rule and
      # the kernel replay can see it. The backquotes are Lean name literals.
      # shellcheck disable=SC2016
      printf '%s\n' 'import Lean' 'open Lean Elab Command' 'set_option debug.skipKernelTC true in' \
        'run_cmd liftTermElabM do' \
        '  let forged : TheoremVal := { name := `SomaVerify.SelfTest.forged, levelParams := [], type := mkConst ``False, value := mkConst ``True.intro }' \
        '  addDecl (.thmDecl forged)'
      ;;
    invisible-character)
      # A NO-BREAK SPACE (UTF-8 C2 A0) inside a string literal.
      printf 'def SomaVerify.SelfTest.label : String := "a\302\240b"\n'
      ;;
    clean)
      # Every forbidden word as prose, in comments and in literals, plus a `native` field and
      # identifiers that merely contain the words: all of it must pass.
      cat <<'PROBE'
namespace SomaVerify.SelfTest
/-- Reason strings a tool-policy model quotes verbatim: native tools, a partial match, an
opaque token, an unsafe input, the axiom of choice, sorry, admit, extern, implemented_by,
decide +native, (native := true), _unsafe_rec, skipKernelTC. -/
def bypassReason : String := "bypass: native tool"
def autoReason : String := "auto: native tool"
def prose : String := "sorry, admit: partial, opaque, unsafe, axiom, extern (native := true)"
-- native tools, a partial update, an opaque id, unsafe paths: comments are prose
def raw : String := r#"sorry "partial" unsafe"#
def quote : Char := '"'
def dashes : String := "-- not a comment /- nor this -/"
structure Tool where
  name : String
  native : Bool
def read : Tool := { name := "Read", native := true }
def nativeTools : List Tool := [read]
def isNative (t : Tool) : Bool := t.native
def double (n : Nat) : Nat := n + n
theorem double_two : double 2 = 4 := rfl
def sumTo : Nat -> Nat
  | 0 => 0
  | n + 1 => (n + 1) + sumTo n
theorem sumTo_three : sumTo 3 = 6 := by decide
end SomaVerify.SelfTest
PROBE
      ;;
    *) die "no probe named $1" ;;
  esac
}

# selftest_run <textual> <audit> <replay> <log>: runs the pipeline on the scratch copy with
# those layers and sets OUTCOME to "accepted" or the stage that rejected it.
#
# The subshell is not the left side of `||`: bash ignores `set -e` inside anything run in a
# tested context, and the pipeline must stop at its first failure here as it does in CI.
selftest_run() {
  local status
  set +e
  # The roots are reassigned for this subshell only: the scratch copy stands in for the real
  # tree during one pipeline run.
  # shellcheck disable=SC2030
  (
    set -euo pipefail
    TEXTUAL="$1"
    AUDIT="$2"
    REPLAY="$3"
    LEAN_ROOT="$SELFTEST_ROOT/lean"
    VECTORS_DIR="$SELFTEST_ROOT/vectors"
    run_pipeline
  ) </dev/null >"$4" 2>&1
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    OUTCOME=accepted
    return
  fi
  OUTCOME="$(sed -nE 's/^lean-verify: \[([^]]+)\].*/\1/p' "$4" | tail -n 1)"
  [ -n "$OUTCOME" ] || OUTCOME="an untagged failure (exit $status)"
}

describe_outcome() {
  case "$1" in
    accepted | -) echo "$1" ;;
    *) echo "rejected by $1" ;;
  esac
}

# The scratch copy lives in ${TMPDIR:-/tmp}/lean-verify-selftest.XXXXXX and is removed on exit.
# A run killed outright (SIGKILL, a CI timeout) skips the EXIT trap and leaves its copy behind,
# so each run first removes copies older than a day: old enough that no live run owns them.
selftest() {
  stage "selftest"
  find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'lean-verify-selftest.*' -mmin +1440 \
    -exec rm -rf {} + 2>/dev/null || true
  SELFTEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lean-verify-selftest.XXXXXX")"
  trap 'rm -rf "$SELFTEST_ROOT"' EXIT
  mkdir "$SELFTEST_ROOT/lean" "$SELFTEST_ROOT/vectors"
  # The real tree: selftest_run's reassignment never reaches this shell.
  # shellcheck disable=SC2031
  cd "$LEAN_ROOT"
  cp -R SomaVerify lakefile.toml lean-toolchain "$SELFTEST_ROOT/lean/"
  if [ -f lake-manifest.json ]; then cp lake-manifest.json "$SELFTEST_ROOT/lean/"; fi
  local probe_dir="$SELFTEST_ROOT/lean/SomaVerify/SelfTest"
  [ ! -e "$probe_dir" ] || die "SomaVerify/SelfTest is reserved for --selftest"

  local name want_gate want_plain want_kernel got_gate got_plain got_kernel detail verdict log
  local wrong=0
  for name in "${SELFTEST_PROBES[@]}"; do
    IFS='|' read -r want_gate want_plain want_kernel <<<"$(selftest_expected "$name")"
    mkdir -p "$probe_dir"
    probe_source "$name" >"$probe_dir/Probe.lean"

    selftest_run 1 1 1 "$SELFTEST_ROOT/$name.gate.log"
    got_gate="$OUTCOME"
    selftest_run 0 1 1 "$SELFTEST_ROOT/$name.plain.log"
    got_plain="$OUTCOME"
    got_kernel=-
    if [ "$want_kernel" != - ]; then
      selftest_run 0 0 1 "$SELFTEST_ROOT/$name.kernel.log"
      got_kernel="$OUTCOME"
    fi
    rm -rf "$probe_dir" "$SELFTEST_ROOT/lean/.lake/build/lib/lean/SomaVerify/SelfTest" \
      "$SELFTEST_ROOT/lean/.lake/build/ir/SomaVerify/SelfTest"

    detail="gate: $(describe_outcome "$got_gate"); without textual checks: $(describe_outcome "$got_plain")"
    if [ "$want_kernel" != - ]; then
      detail="$detail; kernel replay alone: $(describe_outcome "$got_kernel")"
    fi
    if [ "$got_gate" = "$want_gate" ] && [ "$got_plain" = "$want_plain" ] && [ "$got_kernel" = "$want_kernel" ]; then
      verdict=rejected
      [ "$want_gate" != accepted ] || verdict=accepted
      echo "selftest: $name $verdict ($detail)"
    else
      wrong=$((wrong + 1))
      echo "selftest: $name WRONG ($detail)"
      echo "  expected gate: $(describe_outcome "$want_gate"); without textual checks: $(describe_outcome "$want_plain"); kernel replay alone: $(describe_outcome "$want_kernel")"
      for log in "$SELFTEST_ROOT/$name".*.log; do
        echo "  --- tail of $(basename "$log")"
        tail -n 12 "$log" | sed 's/^/  /'
      done
    fi
  done
  [ "$wrong" -eq 0 ] || die "$wrong of ${#SELFTEST_PROBES[@]} probes had the wrong outcome"
  echo "selftest: ok: ${#SELFTEST_PROBES[@]} probes, every outcome as expected"
}

main() {
  local mode=gate
  case "$#:${1:-}" in
    0:) ;;
    1:--check) mode=check ;;
    1:--selftest) mode=selftest ;;
    *)
      echo "usage: $0 [--check | --selftest]" >&2
      exit 2
      ;;
  esac

  # Appended, not prepended: lake is found even where the runner's PATH lacks elan, while
  # anything the job already put first (setup-node's Node, say) still wins.
  export PATH="$PATH:$HOME/.elan/bin:/opt/homebrew/bin"
  command -v lake >/dev/null 2>&1 ||
    die "lake not found; install elan (the toolchain is pinned by verification/lean/lean-toolchain)"
  command -v perl >/dev/null 2>&1 || die "perl not found; the source gate needs it"

  if [ "$mode" = selftest ]; then
    selftest
    return
  fi
  run_pipeline
  if [ "$mode" = check ]; then
    drift_check
  fi
  echo
  echo "lean-verify: ok: $HANDWRITTEN hand-written theorems (source); $THEOREMS theorem declarations kernel-checked, including lemmas Lean generates; ${#MODULES[@]} modules; standard axioms only"
}

main "$@"
