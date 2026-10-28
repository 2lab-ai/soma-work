#!/bin/bash
# Removes the soma devops broker installed by install.sh: boots out the LaunchDaemon and deletes the plist and the
# root-owned code. Keeps the data root (policy, secrets, state, ledger) and logs unless --purge; removes the broker
# user and group only with --purge-user, which needs --purge so no file outlives the uid that owns it.
#
# --purge first copies the ledger to a root-only archive, and refuses while a Cloudflare lease may still hold a live
# token (its key would be deleted with state/, and nothing could revoke it any more) unless --force-unrevoked.
set -euo pipefail

readonly LABEL=ai.soma.devops-broker
readonly BROKER_USER=_somadevops
readonly BROKER_GROUP=soma-devops
readonly SYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin
readonly SHIMMED_TOOLS='dscl dseditgroup launchctl chown sudo otool curl'
readonly LIBEXEC=/usr/local/libexec/soma-devops
readonly STAGE=/usr/local/libexec/.soma-devops.new
readonly OLD=/usr/local/libexec/.soma-devops.old
readonly DATA_ROOT=/usr/local/var/soma-devops
readonly LOG_DIR=/usr/local/var/log/soma-devops
readonly ARCHIVE_DIR=/usr/local/var/soma-devops-archive
readonly PLIST=/Library/LaunchDaemons/$LABEL.plist
# Lease states whose Cloudflare token may still exist (cf-client.ts LeaseState).
readonly UNREVOKED_RE='"state": *"(minting|active|revoking|revoke_failed)"'

trap 'printf "FAIL uninstall.sh stopped at line %s\n" "$LINENO"; exit 1' ERR

usage() {
  cat <<EOF
usage: sudo $0 [--purge [--purge-user] [--force-unrevoked]] [--dry-run]

  (no option)        boot out the daemon, remove the plist and $LIBEXEC; keep data and logs
  --purge            also remove $DATA_ROOT and $LOG_DIR, after copying the ledger to $ARCHIVE_DIR;
                     refused while a Cloudflare lease is not revoked
  --force-unrevoked  purge anyway (the unrevoked tokens must then be deleted in Cloudflare by hand)
  --purge-user       also remove user $BROKER_USER and group $BROKER_GROUP (needs --purge)
  --dry-run          print the actions without changing anything
  --prefix <dir>     tests only (SOMA_DEVOPS_INSTALL_TEST=1), as in install.sh
EOF
}

usage_error() {
  printf 'uninstall.sh: %s\n' "$1" >&2
  usage >&2
  exit 2
}

run() {
  printf '  + %s\n' "$*"
  if [ "$DRY_RUN" = 0 ]; then "$@"; fi
}

PURGE=0 PURGE_USER=0 FORCE_UNREVOKED=0 DRY_RUN=0 PREFIX=''
while [ $# -gt 0 ]; do
  case $1 in
    --purge) PURGE=1 ;;
    --purge-user) PURGE_USER=1 ;;
    --force-unrevoked) FORCE_UNREVOKED=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --prefix)
      if [ $# -lt 2 ] || [ -z "$2" ]; then usage_error '--prefix needs a value'; fi
      PREFIX=$2
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done
if [ "$PURGE_USER" = 1 ] && [ "$PURGE" = 0 ]; then
  usage_error '--purge-user needs --purge: the data files would otherwise outlive the uid that owns them'
fi
if [ "$FORCE_UNREVOKED" = 1 ] && [ "$PURGE" = 0 ]; then
  usage_error '--force-unrevoked only applies to --purge'
fi

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
else
  PATH=$SYSTEM_PATH
  export PATH
  if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then usage_error 'run it with sudo (or add --dry-run to preview)'; fi
fi
cd /

# A file in a broker-owned directory, about to be read by root: a link or anything but a regular file stops here.
broker_file() {
  [ -e "$1" ] || [ -L "$1" ] || return 1
  if [ -L "$1" ] || [ ! -f "$1" ]; then
    printf 'FAIL %s is not a regular file; inspect it by hand, nothing was removed\n' "$1"
    exit 1
  fi
}

# Before anything changes: a purge must not strand a live Cloudflare token.
if [ "$PURGE" = 1 ]; then
  leases=$PREFIX$DATA_ROOT/state/cf-leases.json
  if broker_file "$leases"; then
    unrevoked=$(grep -cE "$UNREVOKED_RE" "$leases" || true)
    if [ "$unrevoked" != 0 ] && [ "$FORCE_UNREVOKED" = 0 ]; then
      printf 'FAIL %s Cloudflare lease(s) in %s are not revoked (minting, active, revoking or revoke_failed); revoke them (cf_lease_revoke, or let the running broker sweep them), or re-run with --force-unrevoked and delete those tokens in Cloudflare by hand; nothing was removed\n' \
        "$unrevoked" "$leases"
      exit 1
    fi
    if [ "$unrevoked" != 0 ]; then
      printf 'WARN %s Cloudflare lease(s) are not revoked; purging anyway (--force-unrevoked): delete their tokens in Cloudflare by hand\n' \
        "$unrevoked"
    fi
  fi
fi

daemon_loaded() { launchctl print "system/$LABEL" >/dev/null 2>&1; }

if daemon_loaded; then
  run launchctl bootout "system/$LABEL" || true
  if [ "$DRY_RUN" = 0 ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      daemon_loaded || break
      sleep 0.5
    done
    if daemon_loaded; then
      printf 'FAIL launchctl bootout system/%s did not unload the daemon; nothing removed\n' "$LABEL"
      exit 1
    fi
  fi
fi

# rm on a symlink removes the link itself, never its target.
for target in "$PLIST" "$LIBEXEC" "$STAGE" "$OLD"; do
  if [ -e "$PREFIX$target" ] || [ -L "$PREFIX$target" ]; then run rm -rf "$PREFIX$target"; fi
done
if [ "$PURGE" = 1 ]; then
  # The audit trail outlives the broker: a root-only, timestamped copy of the ledger.
  ledger=$PREFIX$DATA_ROOT/state/ledger.jsonl
  if broker_file "$ledger"; then
    archive_dir=$PREFIX$ARCHIVE_DIR
    if [ -L "$archive_dir" ] || { [ -e "$archive_dir" ] && [ ! -d "$archive_dir" ]; }; then
      printf 'FAIL %s is not a directory; nothing was purged\n' "$archive_dir"
      exit 1
    fi
    if [ ! -d "$archive_dir" ]; then run mkdir -m 0700 "$archive_dir"; fi
    run chown root:wheel "$archive_dir"
    run chmod 0700 "$archive_dir"
    run chmod -N "$archive_dir"
    copy=$archive_dir/ledger-$(date -u +%Y%m%dT%H%M%SZ).jsonl
    if [ "$DRY_RUN" = 0 ]; then
      tmp=$(mktemp "$archive_dir/.ledger.XXXXXX")
      cat "$ledger" >"$tmp"
      run mv "$tmp" "$copy"
    else
      printf '  + copy %s to %s (root:wheel 0600)\n' "$ledger" "$copy"
    fi
    printf 'ledger archived to %s\n' "$copy"
  fi
  for target in "$DATA_ROOT" "$LOG_DIR"; do
    if [ -e "$PREFIX$target" ] || [ -L "$PREFIX$target" ]; then run rm -rf "$PREFIX$target"; fi
  done
else
  printf 'kept %s and %s (--purge removes them)\n' "$PREFIX$DATA_ROOT" "$PREFIX$LOG_DIR"
fi
if [ "$PURGE_USER" = 1 ]; then
  if dscl . -read "/Users/$BROKER_USER" UniqueID >/dev/null 2>&1; then run dscl . -delete "/Users/$BROKER_USER"; fi
  if dscl . -read "/Groups/$BROKER_GROUP" PrimaryGroupID >/dev/null 2>&1; then
    run dscl . -delete "/Groups/$BROKER_GROUP"
  fi
else
  printf 'kept user %s and group %s (--purge --purge-user removes them)\n' "$BROKER_USER" "$BROKER_GROUP"
fi
if [ "$DRY_RUN" = 1 ]; then printf 'dry run: nothing was changed\n'; fi
