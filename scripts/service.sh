#!/bin/bash

# soma-work - Service Management Script
# Usage: ./scripts/service.sh [env] <command>
#
# Environments:
#   main    /opt/soma-work/main (production)
#   dev     /opt/soma-work/dev (development)
#   (none)  Current directory (local dev)
#
# Uses LaunchAgents (user-level) for service management.
# No sudo required. Service starts when user logs in.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Environment resolution ---
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

# The three SOMA_*_OVERRIDE variables below are a TEST harness, and each of them
# redirects something destructive: PROJECT_DIR decides which tree `stop` hunts
# live processes in, PID_FILE decides which pid the fallback kills, and the scan
# override replaces process discovery outright. An operator shell that inherited
# one of them (a sourced .env, an exported leftover from a test run) would then
# quietly aim a production command at the wrong tree — so honouring them takes a
# deliberate second signal, SOMA_TEST_HARNESS=1, and without it they are ignored
# with one warning on stderr.
#
# Plain `echo` rather than print_warning: resolve_env runs before the print_*
# helpers are defined.
SOMA_TEST_OVERRIDES=0
SOMA_TEST_OVERRIDES_WARNED=0
resolve_test_overrides() {
    if [[ "${SOMA_TEST_HARNESS:-}" == "1" ]]; then
        SOMA_TEST_OVERRIDES=1
        return 0
    fi
    SOMA_TEST_OVERRIDES=0
    if [[ -n "${SOMA_PROJECT_DIR_OVERRIDE:-}${SOMA_PID_FILE_OVERRIDE:-}${SOMA_PROCESS_SCAN_OVERRIDE:-}" && "$SOMA_TEST_OVERRIDES_WARNED" != "1" ]]; then
        SOMA_TEST_OVERRIDES_WARNED=1
        echo "[WARNING] SOMA_PROJECT_DIR_OVERRIDE / SOMA_PID_FILE_OVERRIDE / SOMA_PROCESS_SCAN_OVERRIDE are test-only and were IGNORED (set SOMA_TEST_HARNESS=1 to honour them)" >&2
    fi
    return 0
}

resolve_env() {
    local env="$1"
    case "$env" in
        main)
            SERVICE_NAME="ai.2lab.soma-work.main"
            PROJECT_DIR="/opt/soma-work/main"
            ;;
        dev)
            SERVICE_NAME="ai.2lab.soma-work.dev"
            PROJECT_DIR="/opt/soma-work/dev"
            ;;
        *)
            SERVICE_NAME="ai.2lab.soma-work"
            PROJECT_DIR="$REPO_ROOT"
            ;;
    esac

    resolve_test_overrides

    # SOMA_PROJECT_DIR_OVERRIDE exists only so the contract tests can point the
    # whole project tree (logs/, data/, the process-cwd scan) at a hermetic temp
    # directory instead of the real /opt tree. Same role as
    # SOMA_PID_FILE_OVERRIDE below; never set in production.
    if [[ "$SOMA_TEST_OVERRIDES" == "1" && -n "${SOMA_PROJECT_DIR_OVERRIDE:-}" ]]; then
        PROJECT_DIR="$SOMA_PROJECT_DIR_OVERRIDE"
    fi

    PLIST_PATH="$LAUNCH_AGENTS_DIR/$SERVICE_NAME.plist"
    LOGS_DIR="$PROJECT_DIR/logs"
    # PID lock file written by the app itself (dist/index.js) as "<pid>:<ts>".
    # Authoritative liveness signal for the headless fallback path
    # (start_headless_fallback) on hosts with no GUI/Aqua login session.
    # SOMA_PID_FILE_OVERRIDE exists only so the contract tests can point the
    # pidfile probe at a hermetic temp path instead of the real /opt tree.
    PID_FILE="$PROJECT_DIR/data/soma-work.pid"
    if [[ "$SOMA_TEST_OVERRIDES" == "1" && -n "${SOMA_PID_FILE_OVERRIDE:-}" ]]; then
        PID_FILE="$SOMA_PID_FILE_OVERRIDE"
    fi
    NODE_PATH="$(dirname "$(which node 2>/dev/null || echo "$HOME/.nvm/versions/node/v25.2.1/bin/node")")"
    USER_HOME="$HOME"

    resolve_tool_paths
}

# Discover paths for essential CLI tools (git, gh, aws, dotnet)
# Sets TOOL_PATHS as colon-separated directory list
resolve_tool_paths() {
    TOOL_PATHS=""
    local tools="git gh aws dotnet"
    local search_dirs="/opt/homebrew/bin /usr/local/bin /usr/local/share/dotnet $HOME/.dotnet"

    for tool in $tools; do
        local tool_bin
        tool_bin="$(command -v "$tool" 2>/dev/null)"
        if [[ -z "$tool_bin" ]]; then
            for dir in $search_dirs; do
                if [[ -x "$dir/$tool" ]]; then
                    tool_bin="$dir/$tool"
                    break
                fi
            done
        fi
        if [[ -n "$tool_bin" ]]; then
            local tool_dir
            tool_dir="$(dirname "$tool_bin")"
            if [[ ":$TOOL_PATHS:" != *":$tool_dir:"* ]]; then
                TOOL_PATHS="${TOOL_PATHS:+$TOOL_PATHS:}$tool_dir"
            fi
        fi
    done
}

# --- Transitional delegation to the somawork controller ---
#
# Two owners of one machine's LaunchAgents is the failure this avoids. Once a
# profile is INSTALLED (Homebrew payload: this script ships beside no source
# tree), the TypeScript service manager owns the plist, the labels, and the
# profile paths — `ai.2lab.somawork.{preview,production}` under
# ~/.config/somawork + ~/.local/{share,state}/somawork. The `/opt`-centric
# generator below would write a second, conflicting plist for the same machine.
#
# So: an installed layout hands the five public service actions to the
# controller exactly once, and everything else keeps the source-tree
# implementation verbatim (that is what `./scripts/service.sh dev start` from
# the repo still does, and what Tasks 10/11 validate before this file is
# retired). Commands outside that surface (logs, check-env, reinstall, …) stay
# here until the controller grows equivalents.
#
# ## Why the test is a positive marker, not "has no src/"
#
# The discriminator used to be `package.json && !src/` — "not a source
# checkout, therefore installed". That is false for the tree this script is
# most often run from: `scripts/deploy/stage-bundle.sh` stages `package.json`
# and never stages `src/`, so **the fleet deploy bundle looked installed**. On
# any host where `somawork` was also on PATH — the self-hosted runner that runs
# both the fleet deploy and the release workflow being the obvious one — the
# fleet's own `stop`, `status` and `install` would `exec` the controller and
# operate on the Homebrew profile instead: stopping the wrong daemon before an
# rsync, and verifying a deploy against a service that was never deployed to.
#
# `.somawork-package.json` is the release marker. It is written into the payload
# only by `scripts/release/package-somawork.sh`, declared as the runtime layout
# marker in `scripts/release/render-manifest.ts`, and asserted on every archive
# by `scripts/smoke/package-archives.js`. `stage-bundle.sh` does not produce it.
# So it says exactly the thing the branch needs to know — "this tree came out of
# a release archive" — instead of inferring it from an absence that two very
# different layouts share.
is_packaged_runtime() {
    [[ -f "$REPO_ROOT/.somawork-package.json" ]]
}

# dev → preview, main → production. Non-zero for anything else.
profile_for_env() {
    case "$1" in
        dev)  echo "preview" ;;
        main) echo "production" ;;
        *)    return 1 ;;
    esac
}

maybe_delegate_to_controller() {
    # `exec` below makes re-entry impossible, but the guard keeps a future
    # non-exec caller from looping if the controller ever shells back out.
    [[ -n "${SOMAWORK_SERVICE_SH_DELEGATED:-}" ]] && return 0
    # Escape hatch for exercising the source-tree path from an installed layout.
    [[ -n "${SOMAWORK_SERVICE_SH_NO_DELEGATE:-}" ]] && return 0
    is_packaged_runtime || return 0

    local profile
    profile="$(profile_for_env "$ENV_ARG")" || return 0

    case "$COMMAND" in
        install|start|stop|restart|status) ;;
        *) return 0 ;;
    esac

    local controller
    controller="$(command -v somawork 2>/dev/null)" || return 0
    [[ -n "$controller" ]] || return 0

    export SOMAWORK_SERVICE_SH_DELEGATED=1
    exec "$controller" service "$COMMAND" --profile "$profile"
}

# Parse arguments: [env] <command> [args...]
ENV_ARG=""
COMMAND=""
if [[ "$1" == "main" || "$1" == "dev" ]]; then
    ENV_ARG="$1"
    shift
fi
COMMAND="${1:-}"
shift 2>/dev/null || true

resolve_env "$ENV_ARG"

# Installed profiles belong to the controller; a source checkout does not.
maybe_delegate_to_controller

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status()  { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }

# --- Service helpers ---
# `launchctl list | grep <label>` only proves the LaunchAgent is REGISTERED in
# launchd's user domain. macOS prints `-` in the PID column when the agent is
# registered but the underlying process is dead (e.g. crashed at startup, or
# `LimitLoadToSessionType=Aqua` plist loaded from an SSH/CI session that can't
# spawn into the GUI seat). Two distinct concerns ⇒ two distinct helpers, so
# callers can pick the right one:
#   * `is_registered` — launchd knows about us (stop/unload should target this)
#   * `is_alive`      — there is a real running process (status/start verify
#                       must require this, otherwise CI marks a dead deploy
#                       as green; see PR #988).
#
# `launchctl list` is not the whole answer either. Incident 2026-09-17 (deploy
# run 35209063075, a headless Mac mini): the GitHub runner is a System-session
# LaunchDaemon running as user `dd` and the host has NO Aqua/GUI session, so the
# agent can only be registered in the PER-USER domain (`user/<uid>`) — which the
# runner's `launchctl list` does not necessarily report. Every read-side probe
# therefore also asks each domain directly.
#
# Order matters: `gui/<uid>` is the normal path on a logged-in Mac, `user/<uid>`
# is what exists when there is no GUI seat.
service_domains() {
    local uid
    uid="$(id -u)"
    printf '%s\n' "gui/$uid" "user/$uid"
}

# `launchctl print <domain>/<label>` prints the job dictionary on success, so a
# registration is exit 0 *with a body*. An exit-0 answer that says nothing
# describes no job and is treated as "not visible here" — the same conservative
# reading domain_holds_label() documents for 113/125 further down.
domain_registered() {
    local out
    out="$(launchctl print "$1/$SERVICE_NAME" 2>/dev/null)" || return 1
    [[ -n "$out" ]]
}

# First domain that holds the label, or nothing.
registered_domain() {
    local domain
    while read -r domain; do
        if domain_registered "$domain"; then
            printf '%s\n' "$domain"
            return 0
        fi
    done < <(service_domains)
    return 1
}

# PID out of a domain's job dictionary ("\tpid = 4242").
domain_pid() {
    local out pid
    out="$(launchctl print "$1/$SERVICE_NAME" 2>/dev/null)" || return 1
    pid="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*$/\1/p' | head -1)"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$pid"
}

is_registered() {
    launchctl list 2>/dev/null | grep -q "$SERVICE_NAME" && return 0
    registered_domain >/dev/null
}

# PID from the app's own lock file ("<pid>:<ts>"), validated as a live process.
# This is the source of truth when the service runs OUTSIDE launchd — i.e. the
# headless fallback on a host with no GUI/Aqua login session, where launchctl
# cannot spawn the Aqua-typed LaunchAgent at all.
get_pidfile_pid() {
    [[ -f "$PID_FILE" ]] || return 1
    local raw pid
    raw=$(cat "$PID_FILE" 2>/dev/null)
    pid="${raw%%:*}"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    echo "$pid"
}

# Prefer the launchd-reported PID (normal path, GUI hosts), then the PID each
# launchd domain reports for the label — `launchctl list` does not show a
# user/<uid> registration to every session, and on a headless host that is the
# only domain the agent can live in. Fall back to the app PID lock file so a
# headless direct-spawn is still reported as a real, live process by
# status/start verification.
get_pid() {
    local lpid domain dpid
    lpid=$(launchctl list 2>/dev/null | grep "$SERVICE_NAME" | awk '{print $1}')
    if [[ "$lpid" =~ ^[0-9]+$ ]]; then
        echo "$lpid"
        return 0
    fi
    while read -r domain; do
        if dpid="$(domain_pid "$domain")"; then
            echo "$dpid"
            return 0
        fi
    done < <(service_domains)
    get_pidfile_pid
}

is_alive() {
    local pid
    pid=$(get_pid)
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

# Load the plist AND force the agent to actually spawn.
#
# `launchctl load` only REGISTERS the LaunchAgent in the user domain. When the
# caller's own session is not the GUI/Aqua seat — exactly the case for a GitHub
# Actions self-hosted runner, which launchd starts as a background job — the
# plist's `RunAtLoad` spawn is deferred as "speculative" and the process never
# actually starts (`launchctl print` shows runs=0 / no live PID). The deploy
# then fails the liveness check below with "registered but no live PID".
# `kickstart` targets the GUI domain explicitly and forces the spawn, so the
# service comes up regardless of which session ran the deploy. `load` is made
# tolerant (|| true) because against an already-registered label it is a no-op
# error — kickstart still does the right thing, and is_alive remains the gate.
# Real incident: a dev-channel deploy run on 2026-06-15.
#
# Both calls used to end in `2>/dev/null || true`, which is how deploy run
# 35184945142 (2026-09-17, work-m16) lost its only signal: kickstart failed,
# nothing was printed, and the Verify step then read the PREVIOUS deploy's PID
# out of `launchctl list` and called it green. Stderr is now surfaced and a
# failed kickstart returns non-zero; callers (cmd_start / cmd_install /
# cmd_reinstall) still fall through to start_headless_fallback, which is the
# direct-spawn path for hosts with no GUI/Aqua seat, and only report success
# when is_alive agrees.
#
# The gui domain is not always there. Incident 2026-09-17, deploy run
# 35209063075 on a headless Mac mini: the runner is a System-session
# LaunchDaemon running as `dd`, the host has no Aqua/GUI login session at all,
# and so `kickstart -k gui/<uid>/<label>` answers
# `125: Domain does not support specified action` while `load` registers
# nothing. Measured from an ssh (Background) session on that same host,
# `launchctl bootstrap user/<uid> <plist>` + `kickstart -k user/<uid>/<label>`
# brings the agent up — the per-user domain exists without a GUI seat. So the
# gui domain is tried first (the normal path on a logged-in Mac) and
# `user/<uid>` is the fallback; success in EITHER domain means launchd manages
# the service and the headless direct-spawn is not needed.
load_and_kickstart() {
    local uid load_err kick_err kick_status boot_err boot_status try_user
    uid="$(id -u)"
    LAUNCHD_DOMAIN_USED=""

    if ! load_err="$(launchctl load "$PLIST_PATH" 2>&1 >/dev/null)"; then
        # Against an already-registered label this is an expected no-op error;
        # print it instead of swallowing it so the CI log keeps the evidence.
        print_warning "launchctl load $PLIST_PATH: ${load_err:-<no stderr>}"
    fi

    try_user=0
    if ! launchctl print "gui/$uid" >/dev/null 2>&1; then
        print_warning "launchctl print gui/$uid failed — no GUI/Aqua domain on this host; trying user/$uid"
        try_user=1
    else
        kick_status=0
        kick_err="$(launchctl kickstart -k "gui/$uid/$SERVICE_NAME" 2>&1 >/dev/null)" || kick_status=$?
        if [[ "$kick_status" -eq 0 ]]; then
            LAUNCHD_DOMAIN_USED="gui/$uid"
            return 0
        fi
        print_warning "launchctl kickstart -k gui/$uid/$SERVICE_NAME failed (exit $kick_status): ${kick_err:-<no stderr>}"
        # 125 = "Domain does not support specified action", i.e. this host has
        # no GUI seat to spawn into. Any other failure is about the job, not
        # the domain, so the headless path is the honest next step.
        if [[ "$kick_status" -eq 125 ]]; then
            try_user=1
        fi
    fi

    if [[ "$try_user" -eq 1 ]]; then
        boot_status=0
        boot_err="$(launchctl bootstrap "user/$uid" "$PLIST_PATH" 2>&1 >/dev/null)" || boot_status=$?
        # 37 / 17 = the label is already bootstrapped in this domain — the
        # normal answer on every deploy after the first, and not a failure.
        if [[ "$boot_status" -ne 0 && "$boot_status" -ne 37 && "$boot_status" -ne 17 ]]; then
            print_warning "launchctl bootstrap user/$uid $PLIST_PATH failed (exit $boot_status): ${boot_err:-<no stderr>}"
        fi

        kick_status=0
        kick_err="$(launchctl kickstart -k "user/$uid/$SERVICE_NAME" 2>&1 >/dev/null)" || kick_status=$?
        if [[ "$kick_status" -eq 0 ]]; then
            LAUNCHD_DOMAIN_USED="user/$uid"
            print_status "Service is launchd-managed in the user/$uid domain (no GUI/Aqua session on this host)"
            return 0
        fi
        print_warning "launchctl kickstart -k user/$uid/$SERVICE_NAME failed (exit $kick_status): ${kick_err:-<no stderr>}"
    fi

    print_warning "Falling back to the headless direct-spawn path if the agent does not come up."
    return 1
}

generate_plist() {
    cat << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_NAME</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <!--
          launchd has no log rotation, so instead of pointing StandardOutPath/
          StandardErrorPath straight at the daemon we run a rotating-log
          supervisor (src/run-with-rotating-logs.ts). It spawns dist/index.js,
          tees its stdout/stderr into size-rotated logs/stdout.log + logs/stderr.log,
          and owns retention/gzip. `exec` replaces bash with node so launchd's
          SIGTERM (launchctl unload / stop) reaches the supervisor directly,
          which then forwards it to the daemon for a clean shutdown.
        -->
        <string>export PATH=$NODE_PATH:$TOOL_PATHS:\$PATH; cd $PROJECT_DIR; exec node dist/run-with-rotating-logs.js dist/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_PATH:$TOOL_PATHS:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$USER_HOME</string>
        <key>SOMA_CONFIG_DIR</key>
        <string>$PROJECT_DIR</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <!--
      The supervisor owns logs/stdout.log + logs/stderr.log (rotated) and writes
      its OWN recurring diagnostics to a rotated logs/supervisor.log. These
      launchd paths therefore only capture catastrophic *pre-init* failures
      (node cannot even load the supervisor). They are not rotated by launchd,
      so the supervisor caps them on startup (see capBootstrapLogs). Pointing
      launchd at the rotated files directly would double-open them and defeat
      rotation.
    -->
    <key>StandardOutPath</key>
    <string>$LOGS_DIR/launchd.out.log</string>

    <key>StandardErrorPath</key>
    <string>$LOGS_DIR/launchd.err.log</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF
}

# --- Commands ---
cmd_status() {
    local env_label="${ENV_ARG:-local}"
    echo "=================================="
    echo "soma-work [$env_label] - Status"
    echo "=================================="

    # Exit code contract (consumed by .github/workflows/deploy.yml Verify step):
    #   0 — RUNNING (registered AND live process)
    #   1 — STALE (registered but no live process; usually Aqua-session mismatch
    #              after a non-GUI `launchctl load`) or STOPPED (not registered).
    # Pre-PR-#988 this was always 0, so CI marked dead deploys green.
    local exit_code=0
    if is_alive; then
        local pid=$(get_pid)
        print_success "Service is RUNNING (PID: $pid)"

        local start_time=$(ps -p "$pid" -o lstart= 2>/dev/null)
        if [[ -n "$start_time" ]]; then
            echo "  Started: $start_time"
        fi
    elif is_registered; then
        local pid=$(get_pid)
        print_error "Service is STALE (registered but no live PID: '$pid')"
        echo "  Likely cause: plist 'LimitLoadToSessionType=Aqua' loaded from"
        echo "  a non-GUI session (SSH, CI), or the process crashed at startup."
        echo "  Try: launchctl kickstart -k gui/\$(id -u)/$SERVICE_NAME"
        echo "  On a host with no GUI/Aqua session use the per-user domain:"
        echo "    launchctl bootstrap user/\$(id -u) $PLIST_PATH"
        echo "    launchctl kickstart -k user/\$(id -u)/$SERVICE_NAME"
        exit_code=1
    else
        print_warning "Service is STOPPED"
        exit_code=1
    fi

    echo ""
    echo "Service: $SERVICE_NAME"
    local holder
    holder="$(registered_domain)" && echo "Domain:  $holder"
    echo "Project: $PROJECT_DIR"
    echo "Plist:   $PLIST_PATH"
    echo "Logs:    $LOGS_DIR"

    if [[ -f "$PLIST_PATH" ]]; then
        echo "Plist file: EXISTS"
    else
        print_warning "Plist file: NOT FOUND"
    fi

    echo ""
    echo "Recent stderr (last 5 lines):"
    echo "---"
    tail -5 "$LOGS_DIR/stderr.log" 2>/dev/null || echo "  (no logs)"

    return $exit_code
}

# Headless fallback: spawn the rotating-log supervisor DIRECTLY (not via
# launchd) when there is no GUI/Aqua login session for launchd to schedule the
# Aqua-typed LaunchAgent into. Without this, deploys to a Mac sitting at the
# login window (no console user) fail forever at the start/verify step even
# though the code is healthy. The spawned process must outlive the caller, so it
# is detached into its OWN SESSION (setsid), not merely backgrounded.
#
# Why a new session is mandatory (not just nohup + disown): a CI deploy job
# (GitHub Actions self-hosted runner) SIGKILLs its entire process GROUP when the
# job completes. A bare `nohup ... & disown` stays in that group and is reaped
# seconds after the deploy step finishes (observed on a self-hosted runner:
# the supervisor child exits 137 ~4s after acquiring the PID lock, so the Verify
# step's status check passes in a race window but the service is dead moments
# later). setsid makes the supervisor a session leader in a brand-new
# session/process-group that the job teardown cannot signal, so the freshly
# deployed code keeps running.
#
# macOS has no setsid(1), so prefer the binary when present (Linux) and fall back
# to perl's POSIX::setsid (always available on macOS). The spawned command
# mirrors generate_plist exactly, and is reaped on the next deploy by cmd_stop
# via the same PID lock file. KeepAlive auto-restart is forfeited in this mode
# (documented limitation: restore a GUI login session to regain launchd
# management), but the service runs durably under the deployed code.
start_headless_fallback() {
    local mgr
    mgr="$(launchctl managername 2>/dev/null || echo unknown)"
    print_warning "launchd could not bring up the service (session=$mgr); using headless direct-spawn fallback (new session)."

    mkdir -p "$LOGS_DIR" "$PROJECT_DIR/data"

    local daemon_cmd="cd '$PROJECT_DIR'; exec node dist/run-with-rotating-logs.js dist/index.js"

    if command -v setsid >/dev/null 2>&1; then
        PATH="$NODE_PATH:$TOOL_PATHS:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
        HOME="$USER_HOME" \
        SOMA_CONFIG_DIR="$PROJECT_DIR" \
            setsid bash -c "$daemon_cmd" \
            >> "$LOGS_DIR/launchd.out.log" 2>&1 < /dev/null &
    else
        # perl becomes a session leader via POSIX::setsid, then exec the
        # supervisor (so the leader PID == the running node process).
        PATH="$NODE_PATH:$TOOL_PATHS:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
        HOME="$USER_HOME" \
        SOMA_CONFIG_DIR="$PROJECT_DIR" \
            nohup perl -e 'use POSIX qw(setsid); setsid(); exec("/bin/bash","-c",$ARGV[0]) or die "exec failed: $!";' "$daemon_cmd" \
            >> "$LOGS_DIR/launchd.out.log" 2>&1 < /dev/null &
    fi
    disown 2>/dev/null || true

    # Wait for the app to acquire its PID lock (startup does channel scan etc.).
    local i
    for i in $(seq 1 25); do
        sleep 1
        if get_pidfile_pid >/dev/null 2>&1; then
            return 0
        fi
    done
    return 1
}

# Why the start failed, in the words of the check that actually failed.
#
# Incident 2026-09-17, deploy run 35209063075: the headless fallback failed on a
# host with no GUI session and printed nothing but "Failed to start service" —
# no reason, no log tail — so the operator had to ssh in to learn anything at
# all. The three ways the fallback can end without a live service each get their
# own sentence here.
start_failure_reason() {
    local raw pid
    if [[ ! -f "$PID_FILE" ]]; then
        echo "no pidfile at $PID_FILE — the supervisor never acquired its PID lock"
        return 0
    fi
    raw="$(cat "$PID_FILE" 2>/dev/null)"
    pid="${raw%%:*}"
    if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
        echo "pidfile $PID_FILE holds a non-numeric lock ('$raw')"
    elif ! kill -0 "$pid" 2>/dev/null; then
        echo "pidfile pid=$pid is dead — the supervisor exited right after start"
    else
        echo "is_alive false although pidfile pid=$pid looks live"
    fi
}

# The two logs a pre-init crash lands in (the supervisor's own rotated
# stdout/stderr never get written when node dies before it starts).
print_start_diagnostics() {
    print_error "  reason: $(start_failure_reason)"
    local log
    for log in "$LOGS_DIR/launchd.out.log" "$LOGS_DIR/stderr.log"; do
        echo ""
        if [[ -f "$log" ]]; then
            echo "Last 20 lines of $log:"
            echo "---"
            tail -20 "$log" 2>/dev/null
        else
            echo "No $log to read."
        fi
    done
}

cmd_start() {
    print_status "Starting $SERVICE_NAME..."

    if is_alive; then
        print_warning "Service is already running (PID: $(get_pid))"
        return 0
    fi

    # Registered-but-dead means a prior load left the label in launchd without
    # a live process. `launchctl load` against an already-loaded plist is a
    # no-op, so unload first before retrying.
    if is_registered; then
        print_warning "Service is registered but dead — unloading stale plist first"
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
        sleep 1
    fi

    if [[ ! -f "$PLIST_PATH" ]]; then
        print_error "Plist not found. Run './scripts/service.sh ${ENV_ARG:+$ENV_ARG }install' first."
        return 1
    fi

    load_and_kickstart
    sleep 2

    if is_alive; then
        print_success "Service started (PID: $(get_pid))"
    else
        # launchd path failed (no live process). On a host with no GUI/Aqua
        # session this is expected and permanent — fall back to a direct spawn.
        if start_headless_fallback && is_alive; then
            print_success "Service started via headless fallback (PID: $(get_pid))"
        else
            print_error "Failed to start service (launchd + headless fallback both failed)."
            print_start_diagnostics
            print_error "Check: tail -f $LOGS_DIR/stderr.log"
            return 1
        fi
    fi
}

# --- stop: the three things that can keep old code running ---------------
#
# Incident 2026-09-17, deploy run 35184945142, target work-m16. `service.sh main
# stop` printed "Failed to stop service via LaunchAgent", the pidfile fallback
# matched nothing, the deploy step swallowed the failure with `|| true`, and the
# supervisor from the PREVIOUS deploy (pid 61554, started 4h earlier) kept
# serving while the job went green. Two supervisor trees were alive on the host.
#
# So stop now attacks all three holders and REPORTS honestly:
#   1. the launchd registration — in EVERY domain, not just the one the plist
#      path happens to resolve to (`launchctl unload <plist>` in the runner's
#      session removes at most one; KeepAlive respawns from the others);
#   2. the app's own PID lock file (headless direct-spawn path);
#   3. any live supervisor/daemon process whose cwd is $PROJECT_DIR, whatever
#      started it (orphan from an earlier start, second domain, manual run).
# Exit is non-zero when anything survives — deploy.yml no longer hides it.

# Domains a LaunchAgent label can be registered in on macOS. `system` needs
# root to boot out; we still probe it, because a registration we cannot remove
# is exactly the thing the operator must be told about.
launchd_domains() {
    local uid
    uid="$(id -u)"
    printf '%s\n' "system" "gui/$uid" "user/$uid"
}

# "Held" means `launchctl print` SAW the job — exit 0 and nothing else.
#
# Measured 2026-09-17: as the runner user on fable-m5max, `launchctl print
# system/<label>` exits 113 for BOTH a registered and a non-existent label —
# a non-root process cannot see into the system domain at all. On work-m16 (admin
# user) the same probe exits 0 for a registered label and 113 for a missing one,
# and `gui/<uid>/<label>` exits 0 where registered, 125 where not. So 113/125
# (and any other non-zero) can only be read as "not visible to me", never as
# "held" — treating them as held would fail every deploy run by a non-root
# runner.
#
# The residual: a system-domain registration that a non-root runner cannot see
# is not caught here. Its PROCESS is caught by the cwd scan below — unless that
# process is root-owned too, which a non-root `lsof` also cannot see. That last
# case is left to verify-restart, which fails the deploy when the live PID is
# older than the deploy or logs a different version.
domain_holds_label() {
    launchctl print "$1/$SERVICE_NAME" >/dev/null 2>&1
}

# How long a domain may take to drop the label after a bootout before stop calls
# it stuck. A single 1s probe was shorter than the teardown a healthy host
# performs: the supervisor holds a SIGTERM'd child for DEFAULT_SHUTDOWN_GRACE_MS
# = 4s (src/run-with-rotating-logs.ts:631) before escalating, and `launchctl
# bootout` on a job that is already terminating returns non-zero. Both signals
# say "still here" while the correct thing is happening, so the old code failed
# the deploy on exactly the hosts that were shutting down properly.
STOP_BOOTOUT_WAIT_SECONDS=15

# Boot the label out of every domain that still holds it.
# Sets STOP_DOMAINS_HELD to the domains that refused.
bootout_all_domains() {
    STOP_DOMAINS_HELD=()
    local domain err i still_held
    while read -r domain; do
        domain_holds_label "$domain" || continue
        print_status "Label still registered in $domain — booting out"
        if ! err="$(launchctl bootout "$domain/$SERVICE_NAME" 2>&1)"; then
            # Not proof of failure: a job inside its shutdown grace answers
            # "Operation now in progress". The poll below is the real verdict.
            print_warning "launchctl bootout $domain/$SERVICE_NAME returned non-zero: ${err:-<no stderr>} — polling for the registration to drop"
        fi
        still_held=1
        for ((i = 0; i < STOP_BOOTOUT_WAIT_SECONDS; i++)); do
            if ! domain_holds_label "$domain"; then
                still_held=0
                break
            fi
            sleep 1
        done
        if [[ "$still_held" -eq 1 ]]; then
            print_error "Domain still holds the label after ${STOP_BOOTOUT_WAIT_SECONDS}s: $domain/$SERVICE_NAME"
            if [[ "$domain" == "system" ]]; then
                print_error "  the system domain needs root: sudo launchctl bootout system/$SERVICE_NAME"
            fi
            STOP_DOMAINS_HELD+=("$domain/$SERVICE_NAME")
        fi
    done < <(launchd_domains)
}

# PIDs of live supervisor/daemon processes whose cwd is $PROJECT_DIR, regardless
# of which launchd domain (or none) started them.
#
# `lsof -a -d cwd -c node -Fpn` is the macOS-portable way to read a process's
# cwd (no /proc). The argv filter is load-bearing: without it a local
# `service.sh stop` (PROJECT_DIR == the checkout) would target any node process
# sitting in the repo — the test runner, an editor server. Only the two commands
# the plist and the headless fallback actually launch are ever killed.
#
# SOMA_PROCESS_SCAN_OVERRIDE points the scan at a fake script (invoked with
# $PROJECT_DIR as $1, printing one PID per line) so the contract tests can drive
# stop without any real process discovery. Never set in production.
# stdout of this function is a LIST OF PIDS — the caller reads it with
# `done < <(scan_project_pids)`. Every diagnostic therefore goes to stderr;
# a warning printed on stdout was silently eaten by the caller's numeric guard.
#
# The scan can also fail to produce an answer at all (no lsof, permission
# denied). "No answer" is not "clean": it is the one state in which stop knows
# least, so it records the failure through SCAN_UNAVAILABLE_FLAG (a marker file,
# because this function runs in a process substitution — a subshell — where a
# plain variable assignment could never reach cmd_stop) and cmd_stop refuses to
# report a clean stop.
SCAN_UNAVAILABLE_FLAG=""

mark_scan_unavailable() {
    if [[ -n "$SCAN_UNAVAILABLE_FLAG" ]]; then
        printf '1\n' > "$SCAN_UNAVAILABLE_FLAG" 2>/dev/null
    fi
    return 0
}

scan_project_pids() {
    if [[ "$SOMA_TEST_OVERRIDES" == "1" && -n "${SOMA_PROCESS_SCAN_OVERRIDE:-}" ]]; then
        local scan_status=0
        bash "$SOMA_PROCESS_SCAN_OVERRIDE" "$PROJECT_DIR" || scan_status=$?
        if [[ "$scan_status" -ne 0 ]]; then
            print_warning "process-scan override exited $scan_status — stray-process scan unavailable" >&2
            mark_scan_unavailable
        fi
        return 0
    fi

    if ! command -v lsof >/dev/null 2>&1; then
        print_warning "lsof not found — cannot scan for stray processes under $PROJECT_DIR" >&2
        mark_scan_unavailable
        return 0
    fi

    # lsof reports the RESOLVED cwd, so the raw $PROJECT_DIR string is not
    # enough: /opt/soma-work/* and every macOS temp path are routinely reached
    # through a symlink (/var → /private/var). Compare against both forms.
    local project_dir_real=""
    project_dir_real="$(cd "$PROJECT_DIR" 2>/dev/null && pwd -P)"

    local err_file lsof_out lsof_status=0
    err_file="$(mktemp "${TMPDIR:-/tmp}/soma-stop-lsof.XXXXXX")" || err_file=""
    if [[ -z "$err_file" ]]; then
        # Without a place to capture stderr the scan cannot tell a clean host
        # from a failed probe — refuse to answer rather than fail open.
        print_warning "cannot create a temp file for the lsof scan — scan unavailable" >&2
        mark_scan_unavailable
        return 0
    fi
    lsof_out="$(lsof -a -d cwd -c node -Fpn 2>"$err_file")" || lsof_status=$?

    # Exit 1 with nothing on stderr is lsof's ordinary "no file matched" — a
    # clean host. Any non-zero exit that ALSO wrote a diagnostic (missing
    # permissions, a broken install) means the question went unanswered.
    # macOS lsof also prints "lsof: WARNING: can't stat() ..." for unstat-able
    # volumes while still answering the question — drop those lines before
    # deciding whether stderr carries a real failure.
    if [[ -n "$err_file" && -s "$err_file" ]]; then
        grep -v '^lsof: WARNING:' "$err_file" > "$err_file.filtered" 2>/dev/null || true
        mv -f "$err_file.filtered" "$err_file" 2>/dev/null || true
    fi
    if [[ "$lsof_status" -ne 0 && -n "$err_file" && -s "$err_file" ]]; then
        print_warning "lsof failed (exit $lsof_status): $(tr '\n' ' ' < "$err_file" | cut -c1-200)" >&2
        mark_scan_unavailable
        rm -f "$err_file"
        return 0
    fi
    [[ -n "$err_file" ]] && rm -f "$err_file"

    local line pid="" argv cwd
    while IFS= read -r line; do
        case "$line" in
            p*)
                pid="${line#p}"
                ;;
            n*)
                cwd="${line#n}"
                if [[ "$cwd" != "$PROJECT_DIR" ]]; then
                    [[ -n "$project_dir_real" && "$cwd" == "$project_dir_real" ]] || continue
                fi
                [[ "$pid" =~ ^[0-9]+$ ]] || continue
                [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
                # -ww: without it ps truncates at the terminal width and the
                # argv markers below (which sit at the end of the supervisor's
                # command line) disappear, so a real survivor reads as no match.
                argv="$(ps -ww -p "$pid" -o command= 2>/dev/null)"
                case "$argv" in
                    *dist/run-with-rotating-logs.js*|*dist/index.js*) echo "$pid" ;;
                esac
                ;;
        esac
    done <<< "$lsof_out"
}

# SIGTERM, wait up to 5s, SIGKILL. Returns non-zero if the pid outlives both.
terminate_pid() {
    local pid="$1" i
    kill -0 "$pid" 2>/dev/null || return 0

    print_status "Sending SIGTERM to pid=$pid"
    kill "$pid" 2>/dev/null
    for i in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || { print_success "Process stopped (pid=$pid)"; return 0; }
        sleep 1
    done

    print_warning "pid=$pid still alive, sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
        print_error "Failed to kill process (pid=$pid)"
        return 1
    fi
    print_success "Process killed (pid=$pid)"
    return 0
}

cmd_stop() {
    print_status "Stopping $SERVICE_NAME..."

    # Marker the (subshell) scan writes into when it could not answer.
    local scan_flag_dir scan_unavailable=0
    scan_flag_dir="$(mktemp -d "${TMPDIR:-/tmp}/soma-stop.XXXXXX")" || {
        print_error "cannot create the scan marker dir under ${TMPDIR:-/tmp} — refusing to report a clean stop"
        return 1
    }
    SCAN_UNAVAILABLE_FLAG="$scan_flag_dir/scan-unavailable"

    # Capture the launchd-reported PID BEFORE unloading: if the unload fails we
    # still know which process launchd was supervising.
    local launchd_pid
    launchd_pid="$(launchctl list 2>/dev/null | grep "$SERVICE_NAME" | awk '{print $1}')"

    # `unload` operates on the launchd registration, not on liveness — so use
    # is_registered (alive-or-dead) here. Otherwise a STALE service couldn't
    # be cleaned up, which is exactly the situation we want stop to handle.
    if ! is_registered; then
        print_warning "Service is not running (LaunchAgent)"
    else
        local unload_err
        if ! unload_err="$(launchctl unload "$PLIST_PATH" 2>&1 >/dev/null)"; then
            # `unload` only reaches the domain the caller's session resolves to,
            # and it cannot reach a `user/<uid>` registration made by bootstrap
            # at all — so its failure says nothing about whether the service
            # stopped. The per-domain bootout below is the verdict.
            print_warning "launchctl unload $PLIST_PATH failed: ${unload_err:-<no stderr>} — the per-domain bootout below decides"
        fi
        sleep 2

        if ! is_registered; then
            print_success "Service stopped (LaunchAgent)"
        else
            # NOT the end of the road any more: fall through to the domain
            # bootout, the pidfile kill and the cwd process scan below.
            print_warning "unload did not drop the registration — falling through to the per-domain bootout"
        fi
    fi

    # Every domain, not just whichever one the plist unload reached.
    bootout_all_domains

    local targets=() pid raw

    if [[ "$launchd_pid" =~ ^[0-9]+$ ]]; then
        targets+=("$launchd_pid")
    fi

    # Fallback: kill any process tracked by PID lock file (Issue #152)
    # Catches processes started outside LaunchAgent (e.g., manual node execution)
    if [[ -f "$PID_FILE" ]]; then
        # The app writes the lock as "<pid>:<ts>"; strip the timestamp suffix.
        # Without this, kill -0 sees a non-numeric arg and the fallback never
        # actually terminates a process started outside launchd (e.g. the
        # headless direct-spawn), which would orphan it across deploys.
        raw=$(cat "$PID_FILE" 2>/dev/null)
        pid="${raw%%:*}"
        if [[ "$pid" =~ ^[0-9]+$ ]]; then
            print_status "Found process via PID file (pid=$pid)"
            targets+=("$pid")
        fi
    fi

    # Anything still running out of the project dir, whatever started it.
    while read -r pid; do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        print_status "Found process with cwd=$PROJECT_DIR (pid=$pid)"
        targets+=("$pid")
    done < <(scan_project_pids)

    local kill_failed=0
    for pid in "${targets[@]+"${targets[@]}"}"; do
        terminate_pid "$pid" || kill_failed=1
    done

    # Drop the lock only once nothing holds it, so a failed stop keeps the
    # handle an operator (or the next stop) needs.
    if [[ -f "$PID_FILE" ]]; then
        raw=$(cat "$PID_FILE" 2>/dev/null)
        pid="${raw%%:*}"
        if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
            rm -f "$PID_FILE"
        fi
    fi

    # Re-scan: the authoritative "is anything still running out of this tree"
    # answer. KeepAlive in a second domain shows up here as a NEW pid, which is
    # precisely the failure the old code reported as success.
    local survivors=()
    for pid in "${targets[@]+"${targets[@]}"}"; do
        kill -0 "$pid" 2>/dev/null && survivors+=("$pid")
    done
    while read -r pid; do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        survivors+=("$pid")
    done < <(scan_project_pids)

    if [[ -n "$SCAN_UNAVAILABLE_FLAG" && -f "$SCAN_UNAVAILABLE_FLAG" ]]; then
        scan_unavailable=1
    fi
    SCAN_UNAVAILABLE_FLAG=""
    [[ -n "$scan_flag_dir" ]] && rm -rf "$scan_flag_dir"

    if [[ ${#survivors[@]} -gt 0 || ${#STOP_DOMAINS_HELD[@]} -gt 0 || "$kill_failed" -eq 1 || "$scan_unavailable" -eq 1 ]]; then
        print_error "stop did not reach a clean state:"
        if [[ ${#survivors[@]} -gt 0 ]]; then
            print_error "  still-live process(es) under $PROJECT_DIR: ${survivors[*]}"
        fi
        if [[ ${#STOP_DOMAINS_HELD[@]} -gt 0 ]]; then
            print_error "  label still registered in: ${STOP_DOMAINS_HELD[*]}"
        fi
        if [[ "$scan_unavailable" -eq 1 ]]; then
            print_error "  stray-process scan unavailable — refusing to report a clean stop"
        fi
        return 1
    fi

    print_success "Stopped: no live process under $PROJECT_DIR, no launchd domain holds $SERVICE_NAME"
    return 0
}

cmd_restart() {
    print_status "Restarting $SERVICE_NAME..."
    # Starting on top of a stop that left something alive is how a host ends up
    # with two supervisor trees (incident 2026-09-17, work-m16).
    if ! cmd_stop; then
        print_error "Refusing to start on top of a failed stop."
        return 1
    fi
    sleep 1
    cmd_start
}

# --- verify-restart: proof that THIS deploy's code is the one running -----
#
# `status` answers "a process is alive". After the 2026-09-17 incident that is
# not enough: the alive process was the previous deploy's, 4 hours old, and CI
# read it as success. verify-restart demands two independent pieces of evidence
# that the restart actually happened with the version we just shipped:
#   (a) the live PID's start time is at/after --since (the deploy's own clock
#       reading, taken before the stop), and
#   (b) logs/stdout.log carries this version's startup line
#       "⚡️ Claude Code Slack bot is running! [v<version> (<sha>)]"
#       (src/index.ts) with a log timestamp at/after --since.
# Both are polled, because the line is only written after the Slack socket
# connects, which takes tens of seconds.

# Epoch seconds from `ps -o lstart=` ("Thu Sep 17 14:25:29 2026", local time).
# BSD date first (macOS targets), GNU date second (Linux runners).
#
# `tr -s ' '` first: BSD ps space-pads single-digit days ("Wed Sep  3 …"), and a
# strict "%a %b %d %T %Y" reader that stumbles on the double space would report
# "could not read start time" for every deploy on days 1–9.
lstart_to_epoch() {
    local lstart="$1"
    [[ -n "$lstart" ]] || return 1
    lstart="$(printf '%s' "$lstart" | tr -s ' ')"
    date -j -f "%a %b %d %T %Y" "$lstart" +%s 2>/dev/null && return 0
    date -d "$lstart" +%s 2>/dev/null && return 0
    return 1
}

# Epoch seconds from a log line's leading ISO timestamp, written by the shared
# logger as "[2026-09-17T05:25:29.123Z] [INFO ] [Index] …" (UTC).
log_line_epoch() {
    local line="$1" ts
    ts="${line#\[}"
    ts="${ts%%]*}"
    ts="${ts%%.*}"
    ts="${ts%Z}"
    [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || return 1
    date -j -u -f "%Y-%m-%dT%H:%M:%S" "$ts" +%s 2>/dev/null && return 0
    date -u -d "$ts" +%s 2>/dev/null && return 0
    return 1
}

cmd_verify_restart() {
    # 180s, not 60: measured on fable-m5max 2026-09-17, the supervisor took 5–8s
    # to log "bot is running" on a warm start but 88s and 129s on two cold
    # starts. A 60s budget fails deploys that actually restarted correctly.
    local since="" want_version="" timeout=180

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since)   since="${2:-}";        shift 2 || return 2 ;;
            --version) want_version="${2:-}"; shift 2 || return 2 ;;
            --timeout) timeout="${2:-}";      shift 2 || return 2 ;;
            *)
                print_error "verify-restart: unknown argument '$1'"
                return 2
                ;;
        esac
    done

    if [[ ! "$since" =~ ^[0-9]+$ ]]; then
        print_error "verify-restart requires --since <epoch-seconds>"
        return 2
    fi
    if [[ -z "$want_version" ]]; then
        print_error "verify-restart requires --version <version> (e.g. 0.26.1 or v0.26.1)"
        return 2
    fi
    if [[ ! "$timeout" =~ ^[0-9]+$ ]]; then
        print_error "verify-restart: --timeout must be seconds"
        return 2
    fi

    # Accept the tag form; the log prints "[v<version> (" from version.json.
    want_version="${want_version#v}"
    local log_file="$LOGS_DIR/stdout.log"
    local pattern="bot is running! [v$want_version ("

    print_status "Verifying restart of $SERVICE_NAME (version $want_version, since epoch $since, timeout ${timeout}s)"

    local deadline=$(( $(date +%s) + timeout ))
    local pid start_time start_epoch log_line log_epoch
    local pid_reason="" log_reason=""

    while :; do
        local pid_ok=0 log_ok=0
        pid_reason=""
        log_reason=""
        start_time=""
        log_line=""

        pid="$(get_pid)"
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            start_time="$(ps -p "$pid" -o lstart= 2>/dev/null)"
            start_epoch="$(lstart_to_epoch "$start_time")" || start_epoch=""
            if [[ ! "$start_epoch" =~ ^[0-9]+$ ]]; then
                pid_reason="could not read start time of pid=$pid (ps lstart: '$start_time')"
            elif [[ "$start_epoch" -ge "$since" ]]; then
                pid_ok=1
            else
                pid_reason="pid=$pid started $start_time (epoch $start_epoch) — BEFORE --since $since, i.e. this is the OLD process"
            fi
        else
            pid_reason="no live process (status reports STALE or STOPPED)"
        fi

        log_line="$(grep -F "$pattern" "$log_file" 2>/dev/null | tail -1)"
        if [[ -z "$log_line" ]]; then
            # No ellipsis/em-dash straight after a $var here: bash 3.2 (macOS)
            # swallows "$pattern…" as one identifier and the text vanishes.
            log_reason="no '$pattern' line in $log_file"
        else
            log_epoch="$(log_line_epoch "$log_line")" || log_epoch=""
            if [[ ! "$log_epoch" =~ ^[0-9]+$ ]]; then
                log_reason="could not read the timestamp of the matched line: $log_line"
            elif [[ "$log_epoch" -ge "$since" ]]; then
                log_ok=1
            else
                log_reason="the only matching startup line predates --since $since (epoch $log_epoch): $log_line"
            fi
        fi

        if [[ "$pid_ok" -eq 1 && "$log_ok" -eq 1 ]]; then
            print_success "Restart verified (PID: $pid, started $start_time)"
            echo "  matched: $log_line"
            return 0
        fi

        [[ "$(date +%s)" -ge "$deadline" ]] && break
        sleep 2
    done

    print_error "Restart NOT verified (version $want_version, --since $since, waited ${timeout}s)"
    [[ -n "$pid_reason" ]] && print_error "  process: $pid_reason"
    [[ -n "$log_reason" ]] && print_error "  log: $log_reason"
    echo ""
    echo "Last 10 lines of $log_file:"
    echo "---"
    tail -10 "$log_file" 2>/dev/null || echo "  (no logs)"
    return 1
}

warn_missing_tools() {
    local missing=()
    for tool in git gh aws dotnet; do
        if ! command -v "$tool" &>/dev/null; then
            missing+=("$tool")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        print_warning "Tools not in PATH: ${missing[*]} (run './scripts/service.sh check-env' to fix)"
    fi
}

cmd_install() {
    print_status "Installing $SERVICE_NAME as LaunchAgent..."
    warn_missing_tools

    if [[ ! -d "$PROJECT_DIR" ]]; then
        print_error "Project directory not found: $PROJECT_DIR"
        print_status "Run './scripts/service.sh ${ENV_ARG:+$ENV_ARG }setup' first."
        return 1
    fi

    mkdir -p "$LOGS_DIR"
    mkdir -p "$LAUNCH_AGENTS_DIR"

    generate_plist > "$PLIST_PATH"
    print_success "Plist created: $PLIST_PATH"

    load_and_kickstart
    sleep 2

    if is_alive; then
        print_success "Service installed and started (PID: $(get_pid))"
    else
        # No live process via launchd — on a GUI-less host fall back to a
        # direct spawn so the freshly deployed code actually runs.
        if start_headless_fallback && is_alive; then
            print_success "Service installed and started via headless fallback (PID: $(get_pid))"
        else
            print_error "Service installed but not running (launchd + headless fallback both failed)."
            print_start_diagnostics
            print_error "Check: tail -f $LOGS_DIR/stderr.log"
            return 1
        fi
    fi
}

cmd_uninstall() {
    print_status "Uninstalling $SERVICE_NAME..."

    if is_registered; then
        launchctl unload "$PLIST_PATH"
        sleep 2
    fi

    if [[ -f "$PLIST_PATH" ]]; then
        rm "$PLIST_PATH"
        print_success "Plist removed"
    else
        print_warning "Plist not found"
    fi

    print_success "Service uninstalled"
    print_status "Logs preserved at: $LOGS_DIR"
}

# Search the live log plus its rotated history for a pattern.
# Rotated files are produced by the supervisor's rotating-file-stream as
# `<base>.<n>` and gzip-compressed to `<base>.<n>.gz`. We zgrep the .gz files
# and grep the plain ones so operators can still find evidence that has already
# rotated out of the live file.
search_log_history() {
    local base="$1"      # e.g. stderr.log
    local pattern="$2"
    shopt -s nullglob
    local plain=("$LOGS_DIR/$base" "$LOGS_DIR/$base".[0-9]*)
    local gz=("$LOGS_DIR/$base".*.gz)
    shopt -u nullglob

    if [[ ${#plain[@]} -gt 0 ]]; then
        grep -Hn "$pattern" "${plain[@]}" 2>/dev/null
    fi
    if [[ ${#gz[@]} -gt 0 ]]; then
        zgrep -Hn "$pattern" "${gz[@]}" 2>/dev/null
    fi
}

cmd_logs() {
    local log_type="${1:-stderr}"
    local lines="${2:-50}"

    case "$log_type" in
        stdout|out)
            echo "=== $SERVICE_NAME stdout.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stdout.log"
            ;;
        stderr|err)
            echo "=== $SERVICE_NAME stderr.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stderr.log"
            ;;
        follow|f)
            # -F (follow by name) re-opens the file after rotation, so the
            # stream survives the supervisor rotating stderr.log out from under us.
            echo "=== Following $SERVICE_NAME stderr.log (Ctrl+C to stop) ==="
            tail -F "$LOGS_DIR/stderr.log"
            ;;
        all)
            echo "=== $SERVICE_NAME stdout.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stdout.log"
            echo ""
            echo "=== $SERVICE_NAME stderr.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stderr.log"
            ;;
        history|grep)
            # Usage: logs history <pattern> [stdout|stderr]
            local pattern="$lines"   # second positional arg is the pattern here
            local stream="${3:-stderr}"
            if [[ -z "$pattern" ]]; then
                echo "Usage: ./scripts/service.sh [env] logs history <pattern> [stdout|stderr]"
                return 1
            fi
            local base="stderr.log"
            [[ "$stream" == "stdout" || "$stream" == "out" ]] && base="stdout.log"
            echo "=== Searching $base (+ rotated history) for: $pattern ==="
            search_log_history "$base" "$pattern"
            ;;
        *)
            echo "Usage: ./scripts/service.sh [env] logs [stdout|stderr|follow|all|history] [lines|pattern]"
            ;;
    esac
}

cmd_reinstall() {
    print_status "Reinstalling $SERVICE_NAME..."
    warn_missing_tools
    echo ""

    # Step 1: Stop
    print_status "[1/4] Stopping service..."
    if is_registered; then
        launchctl unload "$PLIST_PATH"
        sleep 2
        if ! is_registered; then
            print_success "Service stopped"
        else
            print_error "Failed to stop service"
            return 1
        fi
    else
        print_warning "Service was not running"
    fi

    # Step 2: Build
    print_status "[2/4] Building project..."
    cd "$PROJECT_DIR" || return 1
    if npm run build; then
        print_success "Build completed"
    else
        print_error "Build failed"
        return 1
    fi

    # Step 3: Update plist
    print_status "[3/4] Updating service configuration..."
    mkdir -p "$LOGS_DIR"
    mkdir -p "$LAUNCH_AGENTS_DIR"
    generate_plist > "$PLIST_PATH"
    print_success "Service configuration updated"

    # Step 4: Start
    print_status "[4/4] Starting service..."
    load_and_kickstart
    sleep 2

    if is_alive; then
        echo ""
        print_success "Reinstall completed! (PID: $(get_pid))"
        echo "  Check logs: ./scripts/service.sh ${ENV_ARG:+$ENV_ARG }logs follow"
    elif is_registered; then
        print_error "Reinstall: label registered but no live PID."
        print_error "Likely Aqua-session mismatch. Try: launchctl kickstart -k gui/\$(id -u)/$SERVICE_NAME"
        return 1
    else
        print_error "Service failed to start. Check: tail -f $LOGS_DIR/stderr.log"
        return 1
    fi
}

# Setup deployment directory (config + data only, no source code)
cmd_setup() {
    if [[ -z "$ENV_ARG" ]]; then
        print_error "Setup requires an environment: ./scripts/service.sh main setup  or  ./scripts/service.sh dev setup"
        return 1
    fi

    print_status "Setting up $ENV_ARG environment at $PROJECT_DIR..."

    # Create directory (needs sudo for /opt)
    if [[ ! -d "$PROJECT_DIR" ]]; then
        sudo mkdir -p "$PROJECT_DIR"
        sudo chown "$(whoami):staff" "$PROJECT_DIR"
    fi

    # Create required directories
    mkdir -p "$PROJECT_DIR/logs"
    mkdir -p "$PROJECT_DIR/data"

    # Check for required config files
    echo ""
    if [[ ! -f "$PROJECT_DIR/.env" ]]; then
        print_warning ".env file missing! Copy from template:"
        echo "  cp /path/to/.env.example $PROJECT_DIR/.env"
    else
        print_success ".env file found"
    fi

    if [[ ! -f "$PROJECT_DIR/.system.prompt" ]]; then
        print_warning ".system.prompt missing! Copy from template:"
        echo "  cp .system.prompt.example $PROJECT_DIR/.system.prompt"
    else
        print_success ".system.prompt found"
    fi

    if [[ ! -f "$PROJECT_DIR/config.json" ]]; then
        print_warning "config.json missing! Copy from template:"
        echo "  cp config.example.json $PROJECT_DIR/config.json"
    else
        print_success "config.json found"
    fi

    echo ""
    echo "Directory structure:"
    echo "  $PROJECT_DIR/"
    echo "    .env               # config (manual)"
    echo "    .system.prompt     # config (manual)"
    echo "    config.json        # config (manual)"
    echo "    data/              # runtime data (auto)"
    echo "    logs/              # logs (auto)"
    echo "    dist/              # deployed by CI (auto)"
    echo "    node_modules/      # deployed by CI (auto)"
    echo "    package.json       # deployed by CI (auto)"

    echo ""
    print_success "Setup complete for $ENV_ARG at $PROJECT_DIR"
    print_status "Next: Copy config files, then push to trigger CI deploy"
}

# Status all environments
cmd_status_all() {
    for env in main dev; do
        resolve_env "$env"
        echo ""
        cmd_status
        echo ""
    done
}

cmd_check_env() {
    echo "=================================="
    echo "soma-work - Environment Check"
    echo "=================================="
    echo ""

    local missing=""

    for tool in git gh aws dotnet; do
        local tool_bin
        tool_bin="$(command -v "$tool" 2>/dev/null)"
        if [[ -n "$tool_bin" ]]; then
            local version
            version="$("$tool" --version 2>/dev/null | head -1)"
            print_success "$tool: $tool_bin ($version)"
        else
            print_error "$tool: NOT FOUND"
            missing="$missing $tool"
        fi
    done

    # Node (always required)
    echo ""
    local node_bin
    node_bin="$(command -v node 2>/dev/null)"
    if [[ -n "$node_bin" ]]; then
        print_success "node: $node_bin ($(node --version 2>/dev/null))"
    else
        print_error "node: NOT FOUND (required)"
    fi

    # Resolved TOOL_PATHS
    echo ""
    print_status "Resolved TOOL_PATHS: ${TOOL_PATHS:-<empty>}"
    print_status "NODE_PATH: $NODE_PATH"

    # Offer to install missing tools
    if [[ -n "$missing" ]]; then
        echo ""
        print_warning "Missing tools:$missing"
        echo ""
        for tool in $missing; do
            case "$tool" in
                git)    echo "  $tool: xcode-select --install" ;;
                gh)     echo "  $tool: brew install gh" ;;
                aws)    echo "  $tool: brew install awscli" ;;
                dotnet) echo "  $tool: brew install dotnet" ;;
            esac
        done
        echo ""
        read -r -p "Install missing tools via Homebrew? [y/N] " answer
        if [[ "$answer" =~ ^[Yy]$ ]]; then
            for tool in $missing; do
                local install_cmd
                case "$tool" in
                    git)    install_cmd="xcode-select --install" ;;
                    gh)     install_cmd="brew install gh" ;;
                    aws)    install_cmd="brew install awscli" ;;
                    dotnet) install_cmd="brew install dotnet" ;;
                esac
                print_status "Running: $install_cmd"
                eval "$install_cmd"
            done
            echo ""
            print_status "Re-checking after install..."
            resolve_tool_paths
            echo ""
            print_status "Updated TOOL_PATHS: ${TOOL_PATHS:-<empty>}"
        fi
    else
        echo ""
        print_success "All tools available"
    fi
}

# --- Main ---
case "$COMMAND" in
    status)
        cmd_status
        ;;
    status-all)
        cmd_status_all
        ;;
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    verify-restart)
        cmd_verify_restart "$@"
        ;;
    install)
        cmd_install
        ;;
    uninstall)
        cmd_uninstall
        ;;
    reinstall)
        cmd_reinstall
        ;;
    setup)
        cmd_setup
        ;;
    logs)
        cmd_logs "$1" "$2"
        ;;
    check-env)
        cmd_check_env
        ;;
    *)
        echo "soma-work - Service Manager"
        echo ""
        echo "Usage: ./scripts/service.sh [env] <command> [args]"
        echo ""
        echo "Environments:"
        echo "  main       Production  (/opt/soma-work/main)"
        echo "  dev        Development (/opt/soma-work/dev)"
        echo "  (none)     Current directory (local dev)"
        echo ""
        echo "Commands:"
        echo "  status       Show service status"
        echo "  status-all   Show all environments"
        echo "  start        Start the service"
        echo "  stop         Stop the service (non-zero if anything survives)"
        echo "  restart      Restart (no rebuild)"
        echo "  verify-restart --since <epoch-seconds> --version <ver> [--timeout <sec>]"
        echo "               Prove the RUNNING process is this version and started after <epoch>"
        echo "  reinstall    Stop, rebuild, start (after code changes)"
        echo "  install      Install as LaunchAgent"
        echo "  uninstall    Remove LaunchAgent"
        echo "  setup        Initialize deployment directory (config only)"
        echo "  check-env    Verify CLI tools and offer to install missing ones"
        echo "  logs         View logs [stdout|stderr|follow|all|history] [lines|pattern]"
        echo ""
        echo "Examples:"
        echo "  ./scripts/service.sh status              # Local status"
        echo "  ./scripts/service.sh main status          # Production status"
        echo "  ./scripts/service.sh dev setup            # Initialize dev config dir"
        echo "  ./scripts/service.sh main logs follow     # Stream production logs (rotation-safe)"
        echo "  ./scripts/service.sh main verify-restart --since 1789622729 --version 0.26.1"
        echo "  ./scripts/service.sh main logs history ERROR  # Search live + rotated logs"
        echo "  ./scripts/service.sh status-all           # All environments"
        echo ""
        echo "Deployment: Push to dev/main branch triggers CI auto-deploy"
        ;;
esac
