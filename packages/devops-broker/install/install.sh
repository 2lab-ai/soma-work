#!/bin/bash
# Installs or upgrades the soma devops broker on macOS (.prd/16-devops-tools-architecture.md §2, §7, §8): the
# broker OS user and group, root-owned node, gh and broker code, the data tree and the LaunchDaemon. Run it with
# sudo; running it again is the upgrade. README.md next to this file has the details.
#
# node and gh come only from the official release archives pinned by sha256 in pins.txt (downloaded, or given with
# --node-archive / --gh-archive) — never from a PATH. The broker code comes from a checkout the bot user cannot
# write. Nothing is changed until every check on the checkout and on the staged copy has passed.
#
# Exit status: 0 = installed and the daemon was started; 3 = installed, daemon not started (policy.json or a
# secret is not in place yet — the output says what to do next); 1 = a check failed (FAIL lines); 2 = usage.
set -euo pipefail
umask 022

readonly LABEL=ai.soma.devops-broker
readonly BROKER_USER=_somadevops
readonly BROKER_GROUP=soma-devops
# Decimal for launchd: 63 = 0o077. Anything the broker creates without an explicit mode stays private to it;
# the broker sets its socket to 0660 itself (README "Umask").
readonly UMASK_DECIMAL=63
# New system ids are taken from the top of this range, below Apple's 500 boundary.
readonly ID_HIGH=499
readonly ID_LOW=401
readonly MIN_NODE_MAJOR=22
readonly SYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin
readonly SHIMMED_TOOLS='dscl dseditgroup launchctl chown sudo otool curl'
readonly NODE_DIST=https://nodejs.org/dist
readonly GH_RELEASES=https://github.com/cli/cli/releases/download
readonly GH_PROBE_ENV='GH_TELEMETRY=disabled DO_NOT_TRACK=1 GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1'

# Target paths. On disk each one is "$PREFIX<path>"; PREFIX is empty except in test mode.
readonly LIBEXEC=/usr/local/libexec/soma-devops
readonly STAGE=/usr/local/libexec/.soma-devops.new
readonly OLD=/usr/local/libexec/.soma-devops.old
readonly APP_REL=app/node_modules/@soma
readonly CLI=$LIBEXEC/$APP_REL/devops-broker/dist/cli.js
readonly DATA_ROOT=/usr/local/var/soma-devops
readonly LOG_DIR=/usr/local/var/log/soma-devops
readonly PLIST=/Library/LaunchDaemons/$LABEL.plist

SCRIPT_DIR=$(cd -P "$(dirname "$0")" && pwd)
readonly SCRIPT_DIR
readonly TEMPLATE=$SCRIPT_DIR/$LABEL.plist.template
readonly PINS=$SCRIPT_DIR/pins.txt

FAILS=0
CHECK_FAILS=0
ERR_REPORTED=0
STAGE_MADE=0
SWAPPED=0
PROBE=''

# shellcheck disable=SC2329 # called from the ERR trap
on_error() {
  ERR_REPORTED=1
  printf 'FAIL install.sh stopped at line %s; fix the cause and run it again\n' "$1"
}

# A failed run never leaves a half-built stage or a probe directory behind.
# shellcheck disable=SC2329 # called from the EXIT trap
on_exit() {
  local status=$?
  if [ -n "$PROBE" ]; then rm -rf "$PROBE"; fi
  if [ "$status" != 0 ] && [ "$STAGE_MADE" = 1 ] && [ "$SWAPPED" = 0 ]; then rm -rf "$PREFIX$STAGE"; fi
  if [ "$status" = 1 ] && [ "$FAILS" = 0 ] && [ "$CHECK_FAILS" = 0 ] && [ "$ERR_REPORTED" = 0 ]; then
    printf 'FAIL install.sh stopped on an unexpected error; fix the cause and run it again\n'
  fi
}
trap 'on_error $LINENO' ERR
trap on_exit EXIT

usage() {
  cat <<EOF
usage: sudo $0 --bot-user <name> [--node-archive <file>] [--gh-archive <file>] [--repo <dir>]
                 [--accept-slack-cli-login] [--operator-is-bot-user] [--dry-run]

  --bot-user <name>          OS user the soma bot runs as; it joins group $BROKER_GROUP to reach the broker socket
  --node-archive <file>      the official node release archive pinned in pins.txt (default: download it)
  --gh-archive <file>        the official gh release archive pinned in pins.txt (default: download it)
  --repo <dir>               soma-work checkout with the devops packages built (default: this script's checkout)
  --accept-slack-cli-login   the bot user's Slack CLI login was checked (README); report it as a WARN, not a FAIL
  --operator-is-bot-user     accept running from the bot user (README "Operator account"); report it as a WARN
  --dry-run                  print the actions without changing anything
  --prefix <dir>             tests only (SOMA_DEVOPS_INSTALL_TEST=1): install under <dir>; $SHIMMED_TOOLS
                             must be shims ahead of the system tools on PATH
EOF
}

usage_error() {
  printf 'install.sh: %s\n' "$1" >&2
  usage >&2
  exit 2
}

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }

fail_line() {
  printf 'FAIL %s\n' "$*"
  FAILS=$((FAILS + 1))
}

die() {
  fail_line "$@"
  exit 1
}

# Prints every action; changes nothing in a dry run.
run() {
  printf '  + %s\n' "$*"
  if [ "$DRY_RUN" = 0 ]; then "$@"; fi
}

# Absolute physical path of an existing file or directory.
absolute() {
  if [ -d "$1" ]; then
    (cd -P "$1" && pwd)
  else
    printf '%s/%s\n' "$(cd -P "$(dirname "$1")" && pwd)" "$(basename "$1")"
  fi
}

# ---- arguments ----------------------------------------------------------------------------------------------

BOT_USER='' NODE_ARCHIVE='' GH_ARCHIVE='' REPO='' PREFIX='' DRY_RUN=0 ACCEPT_SLACK_LOGIN=0 OPERATOR_IS_BOT_USER=0
while [ $# -gt 0 ]; do
  case $1 in
    --bot-user | --node-archive | --gh-archive | --repo | --prefix)
      if [ $# -lt 2 ] || [ -z "$2" ]; then usage_error "$1 needs a value"; fi
      case $1 in
        --bot-user) BOT_USER=$2 ;;
        --node-archive) NODE_ARCHIVE=$2 ;;
        --gh-archive) GH_ARCHIVE=$2 ;;
        --repo) REPO=$2 ;;
        --prefix) PREFIX=$2 ;;
      esac
      shift 2
      ;;
    --node | --gh)
      usage_error "$1 was removed: node and gh come only from the official archives pinned in pins.txt ($1-archive <file>, or none to download)"
      ;;
    --accept-slack-cli-login)
      ACCEPT_SLACK_LOGIN=1
      shift
      ;;
    --operator-is-bot-user)
      OPERATOR_IS_BOT_USER=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

TEST_MODE=0
CURL=/usr/bin/curl
if [ -n "$PREFIX" ]; then
  [ "${SOMA_DEVOPS_INSTALL_TEST:-}" = 1 ] || usage_error '--prefix is for tests only and needs SOMA_DEVOPS_INSTALL_TEST=1'
  [ "$(id -u)" != 0 ] || usage_error 'test mode (--prefix) refuses to run as root'
  [ -d "$PREFIX" ] || usage_error "--prefix $PREFIX is not a directory"
  PREFIX=$(cd -P "$PREFIX" && pwd)
  [ "$PREFIX" != / ] || usage_error '--prefix cannot be /'
  for tool in $SHIMMED_TOOLS; do
    found=$(command -v "$tool" || true)
    case ${found%/*} in
      '' | /usr/bin | /bin | /usr/sbin | /sbin)
        usage_error "test mode needs a $tool shim ahead of the system one on PATH (found: ${found:-nothing})"
        ;;
    esac
  done
  TEST_MODE=1
  CURL=curl
else
  # Only system tools from here on, whatever PATH the caller had.
  PATH=$SYSTEM_PATH
  export PATH
fi

[ -n "$BOT_USER" ] || usage_error '--bot-user is required'
case $BOT_USER in
  root | nobody | "$BROKER_USER") usage_error "--bot-user cannot be $BOT_USER" ;;
  -* | *[!A-Za-z0-9_.-]*) usage_error '--bot-user must be a plain user name' ;;
esac
for given in "$NODE_ARCHIVE" "$GH_ARCHIVE" "$REPO"; do
  if [ -n "$given" ] && [ ! -e "$given" ]; then usage_error "$given does not exist"; fi
done
if [ -n "$NODE_ARCHIVE" ]; then NODE_ARCHIVE=$(absolute "$NODE_ARCHIVE"); fi
if [ -n "$GH_ARCHIVE" ]; then GH_ARCHIVE=$(absolute "$GH_ARCHIVE"); fi
if [ -n "$REPO" ]; then REPO=$(absolute "$REPO"); else REPO=$(cd -P "$SCRIPT_DIR/../../.." && pwd); fi
SCRIPT_REPO=$(cd -P "$SCRIPT_DIR/../../.." && pwd)
# Nothing below depends on the caller's working directory, which the broker user and nobody cannot read anyway.
cd /

# Ownership the checklist expects on disk. Test mode cannot chown (the shim only records the request), so root
# and the broker user stand for the test user, and wheel and soma-devops for the prefix's group.
if [ "$TEST_MODE" = 1 ]; then
  ROOT_UID=$(id -u)
  OWN_ROOT="$ROOT_UID:$(stat -f %g "$PREFIX")"
else
  ROOT_UID=0
  OWN_ROOT=0:0
fi

# ---- helpers ------------------------------------------------------------------------------------------------

# Words of a local directory record attribute (one line); fails when the record or the attribute is missing.
dscl_words() {
  local out
  out=$(dscl . -read "$1" "$2" 2>/dev/null) || return 1
  case $out in
    "$2:"*) out=${out#"$2:"} ;;
    *) return 1 ;;
  esac
  # shellcheck disable=SC2086 # split the value into its words
  printf '%s\n' $out
}

# First word of a local directory record attribute.
dscl_get() {
  local out
  out=$(dscl_words "$1" "$2") || return 1
  out=${out%%$'\n'*}
  [ -n "$out" ] || return 1
  printf '%s\n' "$out"
}

set_attr() {
  local current
  current=$(dscl_get "$1" "$2" || true)
  if [ "$current" != "$3" ]; then run dscl . -create "$1" "$2" "$3"; fi
}

in_list() { printf '%s\n' "$2" | grep -qx -- "$1"; }

# Highest id in ID_LOW..ID_HIGH that is neither a UID nor a GID.
free_id() {
  local id=$ID_HIGH
  while [ "$id" -ge "$ID_LOW" ]; do
    if ! in_list "$id" "$USED_UIDS" && ! in_list "$id" "$USED_GIDS"; then
      printf '%s\n' "$id"
      return 0
    fi
    id=$((id - 1))
  done
  return 1
}

# Of the paths on stdin, those whose ACL has an entry granting something (deny-only ACLs, like the one macOS puts on
# home directories, are fine). Sorted.
acl_grants() {
  local p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    # shellcheck disable=SC2010 # ls -e is the only stock way to read an ACL on macOS
    if ls -led "$p" | grep -q '^ *[0-9][0-9]*: .* allow '; then printf '%s\n' "$p"; fi
  done | sort
}

# The arguments themselves (allow_acl), or everything under them (allow_acl_tree), that an ACL grants access to.
allow_acl() { { find "$@" -maxdepth 0 -acl 2>/dev/null || true; } | acl_grants; }
allow_acl_tree() { { find "$@" -acl 2>/dev/null || true; } | acl_grants; }

# check_dirs <rule> <dir>...: rule "root" = root-owned, not group/other-writable (targets); "trusted" = not owned
# by the bot user, not group/other-writable (the checkout up to its root); "above" = like trusted, but a sticky
# directory may be writable (above the checkout root, nobody else can rename it there). No symlinks, no allow ACLs.
check_dirs() {
  local rule=$1 uid bits owner name p bad=0
  shift
  [ $# -gt 0 ] || return 0
  for p in "$@"; do
    if [ -L "$p" ] || [ ! -d "$p" ]; then
      fail_line "$p is not a real directory (a symlink or a file)"
      bad=1
    fi
  done
  [ "$bad" = 0 ] || return 1
  while read -r uid bits owner name; do
    if [ "$rule" = root ] && [ "$uid" != "$ROOT_UID" ]; then
      fail_line "$name is $owner $bits; it must be owned by root"
      bad=1
    elif [ "$rule" != root ] && [ "$uid" = "$BOT_UID" ]; then
      fail_line "$name is $owner $bits; it is owned by the bot user ($BOT_USER), who could change what gets installed"
      bad=1
    elif [ $((8#$bits & 8#022)) -ne 0 ] && { [ "$rule" != above ] || [ $((8#$bits & 8#1000)) -eq 0 ]; }; then
      fail_line "$name is $owner $bits; it must not be group- or other-writable"
      bad=1
    fi
  done <<EOF
$(stat -f '%u %Mp%Lp %Su:%Sg %N' "$@")
EOF
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    fail_line "$p has an ACL that grants access; remove it (chmod -N)"
    bad=1
  done <<EOF
$(allow_acl "$@")
EOF
  return "$bad"
}

# Every existing directory above a target must be root-owned and not group/other-writable, or a non-root user
# could swap the target out from under the daemon. Directories that do not exist yet are created root:wheel 0755.
check_ancestors() {
  local p=$1 disk dirs=()
  while :; do
    p=${p%/*}
    [ -n "$p" ] || p=/
    if [ "$p" = / ]; then disk=${PREFIX:-/}; else disk=$PREFIX$p; fi
    if [ -e "$disk" ] || [ -L "$disk" ]; then dirs+=("$disk"); fi
    [ "$p" != / ] || break
  done
  check_dirs root ${dirs[@]+"${dirs[@]}"}
}

# Directories from <dir> up to <root> (inclusive), then from above <root> up to /.
dirs_up_to() {
  local p=$1
  while :; do
    printf '%s\n' "$p"
    [ "$p" != "$2" ] || break
    p=${p%/*}
    [ -n "$p" ] || return 0
  done
}

dirs_above() {
  local p=$1
  while [ "$p" != / ]; do
    p=${p%/*}
    [ -n "$p" ] || p=/
    printf '%s\n' "$p"
  done
}

# The checkout the code is copied from must be out of the bot user's reach: every copied file and directory, and
# every directory up to the checkout root, is not owned by the bot user and not group/other-writable; copied
# entries are regular files or directories with one link each (a symlink or a hard link could pull in a file
# the operator never meant to publish); above the root, no directory the bot user could rename the checkout in.
check_checkout() {
  local files=() trees=() f found entry parents='' above='' list=() bad=0
  for f in "$BROKER_PKG/package.json" "$SHARED_PKG/package.json" "$TEMPLATE" "$PINS"; do
    if [ -L "$f" ]; then
      fail_line "$f is a symlink; the installer copies regular files only"
    elif [ ! -f "$f" ]; then
      fail_line "$f is missing or not a regular file"
    else
      files+=("$f")
    fi
  done
  for f in "$BROKER_PKG/dist" "$SHARED_PKG/dist"; do
    if [ -L "$f" ] || [ ! -d "$f" ]; then
      fail_line "$f is missing or not a directory; build packages/process-shared and packages/devops-broker first"
    else
      trees+=("$f")
    fi
  done
  [ "${#files[@]}" = 4 ] && [ "${#trees[@]}" = 2 ] || return 0
  found=$(find "${files[@]}" "${trees[@]}" \( \( ! -type f ! -type d \) -o -uid "$BOT_UID" -o -perm -020 -o -perm -002 \
    -o \( -type f -links +1 \) \) -print | head -n 20 || true)
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if [ -L "$entry" ] || { [ ! -f "$entry" ] && [ ! -d "$entry" ]; }; then
      fail_line "$entry is not a regular file or directory ($(stat -f %HT "$entry")); the installer copies only those"
    elif [ "$(stat -f %u "$entry")" = "$BOT_UID" ]; then
      fail_line "$entry is owned by the bot user ($BOT_USER), who could change what gets installed"
    elif [ -f "$entry" ] && [ "$(stat -f %l "$entry")" != 1 ]; then
      fail_line "$entry is a hard link ($(stat -f %l "$entry") names); the installer copies only files with one link"
    else
      fail_line "$entry is $(stat -f '%Su:%Sg %Mp%Lp' "$entry"); it must not be group- or other-writable"
    fi
  done <<EOF
$found
EOF
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    fail_line "$entry has an ACL that grants access; remove it (chmod -N)"
  done <<EOF
$(find "${files[@]}" "${trees[@]}" -acl 2>/dev/null | while IFS= read -r p; do allow_acl "$p"; done | head -n 20 || true)
EOF
  for f in "$BROKER_PKG" "$SHARED_PKG"; do parents="$parents$(dirs_up_to "$f" "$REPO")"$'\n'; done
  parents="$parents$(dirs_up_to "$SCRIPT_DIR" "$SCRIPT_REPO")"$'\n'
  above="$(dirs_above "$REPO")"$'\n'"$(dirs_above "$SCRIPT_REPO")"
  while IFS= read -r entry; do [ -z "$entry" ] || list+=("$entry"); done <<EOF
$(printf '%s\n' "$parents" | sort -u)
EOF
  check_dirs trusted "${list[@]}" || bad=1
  list=()
  while IFS= read -r entry; do [ -z "$entry" ] || list+=("$entry"); done <<EOF
$(printf '%s\n' "$above" | sort -u)
EOF
  check_dirs above "${list[@]}" || bad=1
  return 0
}

# The version GH_POLICY_GH_VERSION in a process-shared build.
gh_policy_version() {
  sed -n "s/^exports\.GH_POLICY_GH_VERSION = '\([0-9][0-9.]*\)';\$/\1/p" "$1/dist/devops/gh-policy.js"
}

# read_pin <tool>: sets PIN_VERSION PIN_SHA PIN_FILE for this machine from pins.txt.
read_pin() {
  local tool=$1 t a v s f rest count=0 expected
  PIN_VERSION='' PIN_SHA='' PIN_FILE=''
  while read -r t a v s f rest; do
    case $t in '' | '#'*) continue ;; esac
    [ "$t" = "$tool" ] && [ "$a" = "$ARCH" ] || continue
    count=$((count + 1))
    PIN_VERSION=$v PIN_SHA=$s PIN_FILE=$f
    [ -z "$rest" ] || fail_line "$PINS: the $tool $ARCH line has extra fields"
  done <"$PINS"
  if [ "$count" != 1 ]; then
    fail_line "$PINS must have exactly one '$tool $ARCH' line (found $count)"
    return 0
  fi
  case $PIN_VERSION in '' | *[!0-9.]* | .* | *.) fail_line "$PINS: '$tool $ARCH' has a malformed version" ;; esac
  case $PIN_SHA in *[!0-9a-f]*) fail_line "$PINS: '$tool $ARCH' has a malformed sha256" ;; esac
  [ "${#PIN_SHA}" = 64 ] || fail_line "$PINS: '$tool $ARCH' has a malformed sha256"
  if [ "$tool" = node ]; then
    expected=node-v$PIN_VERSION-darwin-$ARCH.tar.gz
  elif [ "$ARCH" = x64 ]; then
    expected=gh_${PIN_VERSION}_macOS_amd64.zip
  else
    expected=gh_${PIN_VERSION}_macOS_arm64.zip
  fi
  [ "$PIN_FILE" = "$expected" ] || fail_line "$PINS: '$tool $ARCH' names $PIN_FILE; the official archive is $expected"
}

# A copied binary must not load anything a non-root user can replace: only /usr/lib and /System/Library.
check_linkage() {
  local what=$1 file=$2 out line lib outside=''
  if ! out=$(otool -L "$file" 2>&1); then
    fail_line "$what $file: otool -L failed (it needs the Xcode Command Line Tools): $(printf '%s\n' "$out" | head -n 1)"
    return 0
  fi
  case $out in
    *'is not an object file'*)
      fail_line "$what $file is not a Mach-O executable"
      return 0
      ;;
  esac
  while IFS= read -r line; do
    case $line in *:) continue ;; esac
    line=${line#"${line%%[![:space:]]*}"}
    lib=${line%% (*}
    case $lib in
      '' | /usr/lib/* | /System/Library/*) ;;
      *) outside="$outside $lib" ;;
    esac
  done <<EOF
$out
EOF
  if [ -n "$outside" ]; then
    fail_line "$what $file loads libraries from outside /usr/lib and /System/Library:$outside"
  fi
}

# obtain <tool> <archive name> <sha256> <url> <given file or empty> <into dir>: the archive, copied or downloaded
# into the root-only stage, then hashed there (what is hashed is what gets extracted).
obtain() {
  local tool=$1 name=$2 sha=$3 url=$4 given=$5 dest=$6/$2 got
  if [ -n "$given" ]; then
    run cp -X "$given" "$dest"
  elif ! run "$CURL" --proto '=https' --tlsv1.2 -fsSL --max-time 900 -o "$dest" "$url"; then
    fail_line "$tool archive download failed: $url"
    return 0
  fi
  got=$(shasum -a 256 "$dest")
  got=${got%% *}
  [ "$got" = "$sha" ] || fail_line "$tool archive $name has sha256 $got; pins.txt pins $sha"
}

# extract <archive> <member> <into dir> <as file>: one regular file out of a verified archive.
extract() {
  if ! run tar -x --no-same-owner --no-same-permissions --no-xattrs --no-acls --no-fflags --no-mac-metadata \
    -f "$1" -C "$3" "$2"; then
    fail_line "$1 could not be extracted"
    return 0
  fi
  if [ -L "$3/$2" ] || [ ! -f "$3/$2" ]; then
    fail_line "$1 has no regular file $2"
    return 0
  fi
  run mv "$3/$2" "$4"
}

# probe <what> <staged binary> <expected first-line prefix> [env...]: runs `<binary> --version` as nobody, from a
# root-owned copy nobody can reach (the stage itself stays 0700), with a clean environment.
probe() {
  local what=$1 binary=$2 expected=$3 out
  shift 3
  run cp -X "$binary" "$PROBE/$what"
  run chmod 0755 "$PROBE/$what"
  out=$(sudo -u nobody -- /usr/bin/env -i PATH="$SYSTEM_PATH" HOME=/var/empty "$@" "$PROBE/$what" --version \
    </dev/null 2>/dev/null | sed -n 1p || true)
  case $out in
    "$expected"*) say "$what --version (as nobody): $out" ;;
    *) fail_line "$what $binary reports \"$out\" as nobody; expected $expected" ;;
  esac
}

# The broker may load only node: built-ins, its own dist and @soma/process-shared. Walks every require() reachable
# from the broker dist (literal specifiers only) and fails on anything else. Two greps index every dist file up
# front; the staged dist has no symlinks (checked before), so paths are resolved as strings.
scan_dependencies() {
  local broker=$1 shared=$2 calls_index specs_index queue=() seen=$'\n' file line spec target base calls literal i=0
  calls_index=$(find "$broker/dist" "$shared/dist" -type f -name '*.js' -exec grep -o -H 'require(' {} + || true)
  specs_index=$(find "$broker/dist" "$shared/dist" -type f -name '*.js' \
    -exec grep -oE -H "require\((\"[^\"]*\"|'[^']*')\)" {} + || true)
  while IFS= read -r file; do queue+=("$file"); done < <(find "$broker/dist" -type f -name '*.js' | sort)
  while [ "$i" -lt "${#queue[@]}" ]; do
    file=${queue[$i]}
    i=$((i + 1))
    case $seen in *$'\n'"$file"$'\n'*) continue ;; esac
    seen="$seen$file"$'\n'
    calls=0
    while IFS= read -r line; do
      case $line in "$file:"*) calls=$((calls + 1)) ;; esac
    done <<EOF
$calls_index
EOF
    literal=0
    while IFS= read -r line; do
      case $line in "$file:require("*) ;; *) continue ;; esac
      literal=$((literal + 1))
      spec=${line#"$file:require("}
      spec=${spec#?}
      spec=${spec%??}
      case $spec in
        *[!A-Za-z0-9@._/:-]* | */./* | */../*)
          fail_line "$file requires a module with an unexpected name"
          continue
          ;;
        node:*) continue ;;
        ./* | ../*)
          base=${file%/*}
          while :; do
            case $spec in
              ./*) spec=${spec#./} ;;
              ../*)
                spec=${spec#../}
                base=${base%/*}
                ;;
              *) break ;;
            esac
          done
          target=$base/$spec
          ;;
        @soma/process-shared) target=$shared/dist/index.js ;;
        @soma/process-shared/*) target=$shared/dist/${spec#@soma/process-shared/} ;;
        *)
          fail_line "$file requires '$spec'; the broker may load only node: built-ins and @soma/process-shared"
          continue
          ;;
      esac
      if [ -f "$target" ]; then
        :
      elif [ -f "$target.js" ]; then
        target=$target.js
      elif [ -f "$target/index.js" ]; then
        target=$target/index.js
      else
        fail_line "$file requires a module that is not in the build: $target"
        continue
      fi
      case $target in
        "$broker/dist/"* | "$shared/dist/"*) queue+=("$target") ;;
        *) fail_line "$file requires a module outside the two packages: $target" ;;
      esac
    done <<EOF
$specs_index
EOF
    if [ "$calls" != "$literal" ]; then
      fail_line "$file calls require() with something other than a string literal"
    fi
  done
  say "runtime modules: $(($(printf '%s' "$seen" | grep -c .))) files, node: built-ins and @soma/process-shared only"
}

# Creates missing directories above a target, root:wheel 0755.
ensure_parents() {
  local p=$1 missing=''
  while :; do
    p=${p%/*}
    if [ -z "$p" ] || [ -e "$PREFIX$p" ]; then break; fi
    missing="$p $missing"
  done
  for p in $missing; do
    run mkdir -m 0755 "$PREFIX$p"
    run chown root:wheel "$PREFIX$p"
  done
}

# A directory whose parent is root-owned (so nobody else can swap it): created if missing, then given its owner
# and mode, and stripped of any ACL. -h: never follow a link.
ensure_dir() {
  local disk=$PREFIX$1 owner=$2 mode=$3
  [ ! -L "$disk" ] || die "$disk is a symlink; refusing to install into it"
  if [ -e "$disk" ] && [ ! -d "$disk" ]; then die "$disk exists and is not a directory"; fi
  if [ ! -d "$disk" ]; then run mkdir -m "$mode" "$disk"; fi
  run chown -h "$owner" "$disk"
  run chmod -h "$mode" "$disk"
  run chmod -h -N "$disk"
}

# A directory inside a broker-owned one: root never creates or chowns there (the broker could have swapped the
# name for a link to something root owns). The broker user creates it; the checklist checks it.
ensure_broker_dir() {
  local disk=$PREFIX$1
  if [ -e "$disk" ] || [ -L "$disk" ]; then return 0; fi
  run sudo -u "$BROKER_USER" -- /bin/mkdir -m 0700 "$disk"
}

policy_template() {
  cat <<'EOF'
{
  "admins": ["<slack-user-id>"],
  "gh": {
    "org": "<github-org>",
    "accounts": {
      "member": { "login": "<member-login>", "class": "member" },
      "org-admin": { "login": "<org-admin-login>", "class": "org-admin" }
    },
    "restWriteAllowlist": []
  },
  "cloudflare": {
    "<env>": {
      "accountId": "<32-hex-account-id>",
      "zones": { "<zone-name>": "<32-hex-zone-id>" },
      "permissionGroups": { "read": ["<permission-group-id>"], "edit": ["<permission-group-id>"] },
      "defaultTtl": "1h",
      "maxTtl": "71h",
      "ipCondition": false
    }
  },
  "approvalTimeout": "5m"
}
EOF
}

render_plist() {
  sed -e "s|@@LABEL@@|$LABEL|g" \
    -e "s|@@USER@@|$BROKER_USER|g" \
    -e "s|@@GROUP@@|$BROKER_GROUP|g" \
    -e "s|@@NODE@@|$LIBEXEC/node|g" \
    -e "s|@@CLI@@|$CLI|g" \
    -e "s|@@GH@@|$LIBEXEC/gh|g" \
    -e "s|@@DATA_ROOT@@|$DATA_ROOT|g" \
    -e "s|@@LOG_DIR@@|$LOG_DIR|g" \
    -e "s|@@UMASK@@|$UMASK_DECIMAL|g" \
    "$TEMPLATE"
}

daemon_loaded() { launchctl print "system/$LABEL" >/dev/null 2>&1; }

# Names directly inside a directory, sorted, space-separated.
entries() { find "$1" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort | tr '\n' ' '; }

check_line() {
  local verdict=$1
  shift
  if [ "$verdict" = OK ]; then printf 'OK   %s\n' "$*"; else
    printf 'FAIL %s\n' "$*"
    CHECK_FAILS=$((CHECK_FAILS + 1))
  fi
}

# check_entry <disk path> <owner:group as named> <uid:gid expected on disk> <mode>
check_entry() {
  local disk=$1 names=$2 ids=$3 mode=$4 got
  if [ -L "$disk" ]; then
    check_line FAIL "$disk is a symlink"
    return 0
  fi
  if [ ! -e "$disk" ]; then
    check_line FAIL "$disk is missing"
    return 0
  fi
  got=$(stat -f '%u:%g %Mp%Lp' "$disk")
  if [ -f "$disk" ] && [ "$(stat -f %l "$disk")" != 1 ]; then
    check_line FAIL "$disk has $(stat -f %l "$disk") hard links"
  elif [ "$got" = "$ids $mode" ]; then
    check_line OK "$(printf '%-28s %s' "$names $mode" "$disk")"
  else
    check_line FAIL "$disk: expected $names $mode ($ids), found $got"
  fi
}

# ---- 1. preflight (reads only) ------------------------------------------------------------------------------

step 'preflight'
[ "$(uname -s)" = Darwin ] || die 'this installer is for macOS'
if [ "$TEST_MODE" = 0 ] && [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
  die 'run it with sudo (or add --dry-run to preview)'
fi
# The bot user's shell files and LaunchAgents are the bot's: whatever is typed or piped in its sessions, it can read.
OPERATOR_WARN=''
if [ "${SUDO_USER:-}" = "$BOT_USER" ]; then
  if [ "$OPERATOR_IS_BOT_USER" = 1 ]; then
    OPERATOR_WARN="operator is the bot user ($BOT_USER): the bot can read a sudo password typed in its sessions and the secrets piped through them; move to a separate operator account (README \"Operator account\")"
  else
    die "SUDO_USER is $BOT_USER, the bot user; run the installer from an operator account the bot does not control, or pass --operator-is-bot-user to accept this (README \"Operator account\")"
  fi
fi
[ -f "$TEMPLATE" ] || die "$TEMPLATE is missing"
[ -f "$PINS" ] || die "$PINS is missing"
BOT_UID=$(dscl_get "/Users/$BOT_USER" UniqueID) || die "user $BOT_USER does not exist"
BOT_HOME=$(dscl_get "/Users/$BOT_USER" NFSHomeDirectory) || die "user $BOT_USER has no home directory record"
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm64; else ARCH=x64; fi

# A Slack CLI login in the bot user's home can mint tokens for every app its human collaborates on.
SLACK_LOGIN=$PREFIX$BOT_HOME/.slack/credentials.json
SLACK_WARN=''
if [ -e "$SLACK_LOGIN" ] || [ -L "$SLACK_LOGIN" ]; then
  if [ "$ACCEPT_SLACK_LOGIN" = 1 ]; then
    SLACK_WARN="$SLACK_LOGIN exists (accepted with --accept-slack-cli-login): its user must be neither a collaborator on the broker's Slack app nor in policy.json admins (README \"Slack CLI login\")"
  else
    fail_line "$SLACK_LOGIN exists: remove the Slack CLI login from $BOT_USER, or re-run with --accept-slack-cli-login after confirming its user is neither a collaborator on the broker's Slack app nor in policy.json admins (README \"Slack CLI login\")"
  fi
fi

BROKER_PKG=$REPO/packages/devops-broker
SHARED_PKG=$REPO/packages/process-shared
check_checkout
[ "$FAILS" = 0 ] || {
  say "preflight: $FAILS problem(s); nothing was changed"
  exit 1
}

read_pin node
NODE_VERSION=$PIN_VERSION NODE_SHA=$PIN_SHA NODE_FILE=$PIN_FILE
read_pin gh
GH_VERSION=$PIN_VERSION GH_SHA=$PIN_SHA GH_FILE=$PIN_FILE
if [ "$FAILS" = 0 ]; then
  [ "${NODE_VERSION%%.*}" -ge "$MIN_NODE_MAJOR" ] || fail_line "$PINS pins node $NODE_VERSION; the broker needs node $MIN_NODE_MAJOR or newer"
  policy_gh=$(gh_policy_version "$SHARED_PKG")
  [ "$GH_VERSION" = "$policy_gh" ] ||
    fail_line "$PINS pins gh $GH_VERSION but GH_POLICY_GH_VERSION is ${policy_gh:-<missing>}; the gh allowlist is written for that release"
fi
for given in "$NODE_ARCHIVE" "$GH_ARCHIVE"; do
  if [ -n "$given" ] && { [ -L "$given" ] || [ ! -f "$given" ]; }; then fail_line "$given is not a regular file"; fi
done

for target in "$LIBEXEC" "$DATA_ROOT" "$LOG_DIR" "$PLIST"; do
  check_ancestors "$target" || true
done
if [ "$FAILS" != 0 ]; then
  say "preflight: $FAILS problem(s); nothing was changed"
  exit 1
fi

# ---- 2. code: staged 0700, checked, then opened -------------------------------------------------------------

step "code (staged in $STAGE, closed until every check on the copy passes)"
for target in "$LIBEXEC" "$DATA_ROOT" "$LOG_DIR" "$PLIST"; do ensure_parents "$target"; done
for leftover in "$PREFIX$STAGE" "$PREFIX$OLD" "$PREFIX/usr/local/libexec/.soma-devops-probe."*; do
  if [ -e "$leftover" ] || [ -L "$leftover" ]; then run rm -rf "$leftover"; fi
done
stage=$PREFIX$STAGE
s_broker=$stage/$APP_REL/devops-broker
s_shared=$stage/$APP_REL/process-shared
run mkdir -m 0700 "$stage"
STAGE_MADE=1
if [ "$DRY_RUN" = 1 ]; then
  say "  + obtain $NODE_FILE and $GH_FILE (${NODE_ARCHIVE:-$NODE_DIST/v$NODE_VERSION/$NODE_FILE}, ${GH_ARCHIVE:-$GH_RELEASES/v$GH_VERSION/$GH_FILE}), check sha256, extract node and gh"
  say "  + copy package.json and dist of @soma/devops-broker and @soma/process-shared; check the copy; open the stage"
else
  run mkdir -m 0700 "$stage/.download" "$stage/.extract"
  obtain node "$NODE_FILE" "$NODE_SHA" "$NODE_DIST/v$NODE_VERSION/$NODE_FILE" "$NODE_ARCHIVE" "$stage/.download"
  obtain gh "$GH_FILE" "$GH_SHA" "$GH_RELEASES/v$GH_VERSION/$GH_FILE" "$GH_ARCHIVE" "$stage/.download"
  [ "$FAILS" = 0 ] || exit 1
  extract "$stage/.download/$NODE_FILE" "${NODE_FILE%.tar.gz}/bin/node" "$stage/.extract" "$stage/node"
  extract "$stage/.download/$GH_FILE" "${GH_FILE%.zip}/bin/gh" "$stage/.extract" "$stage/gh"
  run rm -rf "$stage/.download" "$stage/.extract"
  [ "$FAILS" = 0 ] || exit 1

  run mkdir -p "$s_broker" "$s_shared"
  run cp -X "$BROKER_PKG/package.json" "$s_broker/package.json"
  run cp -R -X "$BROKER_PKG/dist" "$s_broker/dist"
  run cp -X "$SHARED_PKG/package.json" "$s_shared/package.json"
  run cp -R -X "$SHARED_PKG/dist" "$s_shared/dist"
  odd=$(find "$stage" -mindepth 1 \( \( ! -type f ! -type d \) -o \( -type f -links +1 \) \) -print | head -n 5 || true)
  [ -z "$odd" ] || fail_line "the staged copy has entries that are not single-link files or directories: $(printf '%s ' "$odd")"
  scan_dependencies "$s_broker" "$s_shared"
  staged_gh=$(gh_policy_version "$s_shared")
  [ "$staged_gh" = "$GH_VERSION" ] || fail_line "the staged GH_POLICY_GH_VERSION is ${staged_gh:-<missing>}, not the pinned gh $GH_VERSION"
  check_linkage node "$stage/node"
  check_linkage gh "$stage/gh"
  [ "$FAILS" = 0 ] || exit 1

  run find "$stage" -mindepth 1 -type d -exec chmod 0755 {} +
  run find "$stage" -type f -exec chmod 0644 {} +
  run chmod 0755 "$stage/node" "$stage/gh"
  run chmod -R -P -N "$stage"
  run chown -R root:wheel "$stage"
  PROBE=$(mktemp -d "$PREFIX/usr/local/libexec/.soma-devops-probe.XXXXXX")
  run chmod 0711 "$PROBE"
  probe node "$stage/node" "v$NODE_VERSION"
  # shellcheck disable=SC2086 # GH_PROBE_ENV is a fixed list of NAME=value words
  probe gh "$stage/gh" "gh version $GH_VERSION " $GH_PROBE_ENV
  run rm -rf "$PROBE"
  PROBE=''
  [ "$FAILS" = 0 ] || exit 1
  run chmod 0755 "$stage"
fi

# ---- 3. broker user and group -------------------------------------------------------------------------------

step "broker user $BROKER_USER, group $BROKER_GROUP"
USED_UIDS=$(dscl . -list /Users UniqueID | awk '{ print $NF }')
USED_GIDS=$(dscl . -list /Groups PrimaryGroupID | awk '{ print $NF }')
if BROKER_GID=$(dscl_get "/Groups/$BROKER_GROUP" PrimaryGroupID); then
  say "group $BROKER_GROUP exists (gid $BROKER_GID)"
else
  BROKER_GID=$(free_id) || die "no id between $ID_LOW and $ID_HIGH is free"
  run dscl . -create "/Groups/$BROKER_GROUP"
  run dscl . -create "/Groups/$BROKER_GROUP" PrimaryGroupID "$BROKER_GID"
  run dscl . -create "/Groups/$BROKER_GROUP" RealName 'soma devops broker'
  run dscl . -create "/Groups/$BROKER_GROUP" Password '*'
  USED_GIDS=$(printf '%s\n%s\n' "$USED_GIDS" "$BROKER_GID")
fi
if BROKER_UID=$(dscl_get "/Users/$BROKER_USER" UniqueID); then
  case $BROKER_UID in
    '' | *[!0-9]*) die "$BROKER_USER has a malformed UniqueID" ;;
  esac
  if [ "$BROKER_UID" -le 0 ] || [ "$BROKER_UID" -ge 500 ]; then
    die "$BROKER_USER exists with uid $BROKER_UID; expected a system uid from 1 to 499"
  fi
  say "user $BROKER_USER exists (uid $BROKER_UID)"
else
  if [ "$BROKER_GID" -lt 500 ] && ! in_list "$BROKER_GID" "$USED_UIDS"; then
    BROKER_UID=$BROKER_GID
  else
    BROKER_UID=$(free_id) || die "no id between $ID_LOW and $ID_HIGH is free"
  fi
  run dscl . -create "/Users/$BROKER_USER"
  run dscl . -create "/Users/$BROKER_USER" UniqueID "$BROKER_UID"
  run dscl . -create "/Users/$BROKER_USER" RealName 'soma devops broker'
  run dscl . -create "/Users/$BROKER_USER" Password '*'
  run dscl . -create "/Users/$BROKER_USER" IsHidden 1
fi
set_attr "/Users/$BROKER_USER" PrimaryGroupID "$BROKER_GID"
set_attr "/Users/$BROKER_USER" UserShell /usr/bin/false
set_attr "/Users/$BROKER_USER" NFSHomeDirectory /var/empty

ADDED_TO_GROUP=0
if dseditgroup -o checkmember -m "$BOT_USER" "$BROKER_GROUP" >/dev/null 2>&1; then
  say "$BOT_USER is in $BROKER_GROUP"
else
  run dseditgroup -o edit -a "$BOT_USER" -t user "$BROKER_GROUP"
  ADDED_TO_GROUP=1
fi

BROKER_OWNER=$BROKER_UID:$BROKER_GID
if [ "$TEST_MODE" = 1 ]; then
  OWN_BROKER=$OWN_ROOT
  OWN_DATA_ROOT=$OWN_ROOT
else
  OWN_BROKER=$BROKER_OWNER
  OWN_DATA_ROOT=0:$BROKER_GID
fi

# ---- 4. data ------------------------------------------------------------------------------------------------

step "data $DATA_ROOT, logs $LOG_DIR"
data_root=$PREFIX$DATA_ROOT
# An ACL that grants anything on the data or the logs is removed below, and still fails this run: whoever it named
# may already have read a secret or rewritten the policy.
ACL_FOUND=$(allow_acl_tree "$data_root" "$PREFIX$LOG_DIR")
# The data root is root's: the broker cannot rename, replace or plant anything next to policy.json.
ensure_dir "$DATA_ROOT" "root:$BROKER_GID" 0750
ensure_dir "$DATA_ROOT/secrets" "$BROKER_OWNER" 0700
ensure_dir "$DATA_ROOT/state" "$BROKER_OWNER" 0700
ensure_dir "$DATA_ROOT/run" "$BROKER_OWNER" 0750
ensure_dir "$LOG_DIR" "$BROKER_OWNER" 0700
for kind in gh cf slack; do ensure_broker_dir "$DATA_ROOT/secrets/$kind"; done
# Inside its own directories only the broker user strips ACLs: root must not touch what a link there points to.
if [ -n "$ACL_FOUND" ]; then
  if ! run sudo -u "$BROKER_USER" -- /bin/chmod -R -P -N "$data_root/secrets" "$data_root/state" "$data_root/run" \
    "$PREFIX$LOG_DIR"; then
    warn "the broker user could not remove every ACL under $data_root and $PREFIX$LOG_DIR (the checklist lists what is left)"
  fi
fi

policy=$PREFIX$DATA_ROOT/policy.json
[ ! -L "$policy" ] || die "$policy is a symlink"
if [ -e "$policy" ]; then
  [ -f "$policy" ] || die "$policy is not a regular file"
  links=$(stat -f %l "$policy")
  [ "$links" = 1 ] || die "$policy has $links hard links; remove it, check the other names, and write the policy again"
  say "keeping $policy"
elif [ "$DRY_RUN" = 1 ]; then
  say "  + write the policy template (README) to $policy"
else
  tmp=$(mktemp "$data_root/.policy.json.XXXXXX")
  policy_template >"$tmp"
  run mv -f "$tmp" "$policy"
  say "wrote the policy template to $policy; fill it in (README) before the daemon can start"
fi
run chown -h root:wheel "$policy"
run chmod -h 0644 "$policy"
run chmod -h -N "$policy"

# ---- 5. LaunchDaemon ----------------------------------------------------------------------------------------

step "LaunchDaemon $LABEL"
if daemon_loaded; then
  run launchctl bootout "system/$LABEL" || true
  if [ "$DRY_RUN" = 0 ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      daemon_loaded || break
      sleep 0.5
    done
    if daemon_loaded; then die "launchctl bootout system/$LABEL did not unload the daemon"; fi
  fi
fi
if [ -e "$PREFIX$LIBEXEC" ] || [ -L "$PREFIX$LIBEXEC" ]; then run mv "$PREFIX$LIBEXEC" "$PREFIX$OLD"; fi
run mv "$stage" "$PREFIX$LIBEXEC"
SWAPPED=1
if [ -e "$PREFIX$OLD" ]; then run rm -rf "$PREFIX$OLD"; fi

plist=$PREFIX$PLIST
if [ "$DRY_RUN" = 1 ]; then
  say "  + render $TEMPLATE to $plist (root:wheel 0644)"
else
  tmp=$(mktemp "$(dirname "$plist")/.$LABEL.XXXXXX")
  render_plist >"$tmp"
  if grep -q '@@' "$tmp"; then
    rm -f "$tmp"
    die "$TEMPLATE has a field install.sh does not fill"
  fi
  if ! plutil -lint "$tmp" >/dev/null; then
    rm -f "$tmp"
    die 'the rendered LaunchDaemon plist does not lint'
  fi
  run chown root:wheel "$tmp"
  run chmod 0644 "$tmp"
  run chmod -N "$tmp"
  run mv -f "$tmp" "$plist"
fi

node_bin=$PREFIX$LIBEXEC/node
cli_js=$PREFIX$CLI
POLICY_OUT=''
POLICY_STATUS=1
if [ "$DRY_RUN" = 1 ]; then
  say "  + check-policy as $BROKER_USER; the checklist; launchctl bootstrap system $plist when both pass"
else
  # As the broker user, with a clean environment. Its own exit status, whatever it prints.
  if POLICY_OUT=$(sudo -u "$BROKER_USER" -- /usr/bin/env -i PATH="$SYSTEM_PATH" HOME=/var/empty \
    "$node_bin" "$cli_js" check-policy --root "$data_root" 2>&1); then
    POLICY_STATUS=0
  else
    POLICY_STATUS=$?
  fi
  printf '%s\n' "$POLICY_OUT" | sed 's/^/  | /'
  say "  | check-policy exit $POLICY_STATUS"
fi

if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'dry run: nothing was changed'
  exit 0
fi

# ---- 6. checklist (before anything starts) ------------------------------------------------------------------

step 'ownership and permissions'
if [ "$TEST_MODE" = 1 ]; then
  say "(test mode: root and $BROKER_USER are expected as uid:gid $OWN_ROOT on disk; chown was a shim)"
fi
for target in "$LIBEXEC" "$DATA_ROOT" "$LOG_DIR" "$PLIST"; do
  FAILS_BEFORE=$FAILS
  if check_ancestors "$target"; then
    check_line OK "$(printf '%-28s %s' 'root-owned ancestors' "$PREFIX$target")"
  else
    CHECK_FAILS=$((CHECK_FAILS + FAILS - FAILS_BEFORE))
  fi
done
check_entry "$PREFIX$LIBEXEC" root:wheel "$OWN_ROOT" 0755
check_entry "$node_bin" root:wheel "$OWN_ROOT" 0755
check_entry "$PREFIX$LIBEXEC/gh" root:wheel "$OWN_ROOT" 0755
app=$PREFIX$LIBEXEC/app
top=$(entries "$PREFIX$LIBEXEC")
[ "$top" = 'app gh node ' ] || check_line FAIL "$PREFIX$LIBEXEC must hold only app, gh and node (found: $top)"
modules=$(entries "$app/node_modules")
packages=$(entries "$app/node_modules/@soma")
if [ "$modules" = '@soma ' ] && [ "$packages" = 'devops-broker process-shared ' ]; then
  check_line OK "$(printf '%-28s %s' 'node_modules: 2 packages' "$app/node_modules")"
else
  check_line FAIL "$app/node_modules must hold only @soma/devops-broker and @soma/process-shared (found: $modules/ $packages)"
fi
root_uid=${OWN_ROOT%%:*}
root_gid=${OWN_ROOT##*:}
# Tests only: the owner the code tree is held to, so a test can see the owner check fire without root.
if [ "$TEST_MODE" = 1 ] && [ -n "${SOMA_DEVOPS_INSTALL_TEST_CODE_UID:-}" ]; then root_uid=$SOMA_DEVOPS_INSTALL_TEST_CODE_UID; fi
# One group around the whole OR: -print binds to everything, not just the last branch.
wrong=$(find "$app" \( \( -type d \( ! -perm 0755 -o ! -uid "$root_uid" -o ! -gid "$root_gid" \) \) \
  -o \( -type f \( ! -perm 0644 -o ! -uid "$root_uid" -o ! -gid "$root_gid" -o -links +1 \) \) \
  -o \( ! -type d ! -type f \) \) -print)
if [ -z "$wrong" ]; then
  check_line OK "$(printf '%-28s %s' "root:wheel 0755/0644 ($(find "$app" | wc -l | tr -d ' '))" "$app")"
else
  printf '%s\n' "$wrong" | head -n 20 | while IFS= read -r entry; do
    printf 'FAIL %s: expected root:wheel, dirs 0755, files 0644, one link; found %s\n' "$entry" \
      "$(stat -f '%u:%g %Mp%Lp %HT, %l link(s)' "$entry")"
  done
  CHECK_FAILS=$((CHECK_FAILS + 1))
fi
check_entry "$policy" root:wheel "$OWN_ROOT" 0644
check_entry "$data_root" "root:$BROKER_GROUP" "$OWN_DATA_ROOT" 0750
for dir in secrets secrets/gh secrets/cf secrets/slack state; do
  check_entry "$data_root/$dir" "$BROKER_USER:$BROKER_GROUP" "$OWN_BROKER" 0700
done
for secret in "$data_root"/secrets/*/*; do
  [ -e "$secret" ] || [ -L "$secret" ] || continue
  check_entry "$secret" "$BROKER_USER:$BROKER_GROUP" "$OWN_BROKER" 0600
done
check_entry "$data_root/run" "$BROKER_USER:$BROKER_GROUP" "$OWN_BROKER" 0750
check_entry "$PREFIX$LOG_DIR" "$BROKER_USER:$BROKER_GROUP" "$OWN_BROKER" 0700
check_entry "$plist" root:wheel "$OWN_ROOT" 0644
# Group soma-devops reaches the socket and the data root: nobody but the bot user may be in it.
members=$(dscl_words "/Groups/$BROKER_GROUP" GroupMembership || true)
others=$(printf '%s\n' "$members" | grep -vx -e "$BOT_USER" -e '' | tr '\n' ' ' || true)
if dscl . -read "/Groups/$BROKER_GROUP" NestedGroups >/dev/null 2>&1; then
  check_line FAIL "group $BROKER_GROUP has nested groups; remove them (dseditgroup -o edit -d <group> -t group $BROKER_GROUP)"
elif [ -n "$others" ]; then
  check_line FAIL "group $BROKER_GROUP has members other than $BOT_USER: ${others% }; remove them (dseditgroup -o edit -d <user> -t user $BROKER_GROUP)"
elif ! in_list "$BOT_USER" "$members"; then
  check_line FAIL "$BOT_USER is not in group $BROKER_GROUP"
else
  check_line OK "$(printf '%-28s %s' "members of $BROKER_GROUP" "$BOT_USER")"
fi
# ACLs found on the data and logs before this run and removed by it, then any ACL grant still left anywhere.
left=$(allow_acl_tree "$PREFIX$LIBEXEC" "$data_root" "$PREFIX$LOG_DIR" "$plist")
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  if ! in_list "$entry" "$left"; then
    check_line FAIL "$entry had an ACL that granted access; the installer removed it. Find out whether it was used (rotate any secret it exposed), then run the installer again"
  fi
done <<EOF
$ACL_FOUND
EOF
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  check_line FAIL "$entry has an ACL that grants access; remove it (chmod -N), find out whether it was used, and run the installer again"
done <<EOF
$left
EOF
if [ -z "$ACL_FOUND" ] && [ -z "$left" ]; then
  check_line OK "$(printf '%-28s %s' 'no ACL grants' "code, data, logs, plist")"
fi
if [ -n "$OPERATOR_WARN" ]; then warn "$OPERATOR_WARN"; fi
if [ -n "$SLACK_WARN" ]; then warn "$SLACK_WARN"; fi

# ---- 7. start, or say what is missing -----------------------------------------------------------------------

STARTED=0
if [ "$CHECK_FAILS" = 0 ] && [ "$POLICY_STATUS" = 0 ]; then
  run launchctl bootstrap system "$plist" || die "launchctl bootstrap system $plist failed"
  STARTED=1
elif [ "$CHECK_FAILS" = 0 ]; then
  step 'next steps (the daemon starts once check-policy passes)'
  ingest="sudo -u $BROKER_USER env -i PATH=/usr/bin:/bin HOME=/var/empty $node_bin $cli_js ingest"
  if ! printf '%s\n' "$POLICY_OUT" | grep -q '^secret files:'; then
    say "1. Fill in $policy (README \"policy.json\"): replace every <...> placeholder; keep it root:wheel 0644."
    say '2. Run this installer again. It then lists one ingest command per secret the policy needs, like:'
    say "     cd / && pbpaste | $ingest gh member --root $data_root; pbcopy </dev/null"
  else
    say 'Copy each secret to the clipboard, then run its line (stdin only; the line clears the clipboard after):'
    printf '%s\n' "$POLICY_OUT" | awk '/^secret files:/ { on = 1; next } on && /^  [a-z]/ { print $1, $2 }' |
      while read -r secret status; do
        case $status in
          ok) ;;
          missing) say "  cd / && pbpaste | $ingest ${secret%%/*} ${secret#*/} --root $data_root; pbcopy </dev/null" ;;
          *) say "  $secret is unusable (see check-policy above); fix its file, or ingest it again" ;;
        esac
      done
  fi
  say 'Then check, and run this installer again to start the daemon:'
  say "  cd / && sudo -u $BROKER_USER env -i PATH=/usr/bin:/bin HOME=/var/empty $node_bin $cli_js check-policy --root $data_root"
fi

say ''
if [ "$ADDED_TO_GROUP" = 1 ]; then
  say "$BOT_USER was just added to $BROKER_GROUP."
fi
say "Restart the soma bot ($BOT_USER) if it has not restarted since joining $BROKER_GROUP: a running process keeps its old groups and cannot reach the socket."
if [ "$CHECK_FAILS" != 0 ]; then
  say "daemon NOT started: $CHECK_FAILS check(s) failed"
  exit 1
fi
if [ "$STARTED" = 0 ]; then
  say 'daemon NOT started: policy.json or a secret is not in place yet (next steps above)'
  exit 3
fi
say "daemon started: sudo launchctl print system/$LABEL"
exit 0
