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

    PLIST_PATH="$LAUNCH_AGENTS_DIR/$SERVICE_NAME.plist"
    LOGS_DIR="$PROJECT_DIR/logs"
    # PID lock file written by the app itself (dist/index.js) as "<pid>:<ts>".
    # Authoritative liveness signal for the headless fallback path
    # (start_headless_fallback) on hosts with no GUI/Aqua login session.
    # SOMA_PID_FILE_OVERRIDE exists only so the contract tests can point the
    # pidfile probe at a hermetic temp path instead of the real /opt tree.
    PID_FILE="${SOMA_PID_FILE_OVERRIDE:-$PROJECT_DIR/data/soma-work.pid}"
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
is_registered() {
    launchctl list 2>/dev/null | grep -q "$SERVICE_NAME"
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

# Prefer the launchd-reported PID (normal path, GUI hosts). Fall back to the
# app PID lock file so a headless direct-spawn is still reported as a real,
# live process by status/start verification.
get_pid() {
    local lpid
    lpid=$(launchctl list 2>/dev/null | grep "$SERVICE_NAME" | awk '{print $1}')
    if [[ "$lpid" =~ ^[0-9]+$ ]]; then
        echo "$lpid"
        return 0
    fi
    get_pidfile_pid
}

is_alive() {
    local pid
    pid=$(get_pid)
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
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
        exit_code=1
    else
        print_warning "Service is STOPPED"
        exit_code=1
    fi

    echo ""
    echo "Service: $SERVICE_NAME"
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
# seconds after the deploy step finishes (observed on macmini: supervisor child
# exits 137 ~4s after acquiring the PID lock, so the Verify step's status check
# passes in a race window but the service is dead moments later). setsid makes
# the supervisor a session leader in a brand-new session/process-group that the
# job teardown cannot signal, so the freshly deployed code keeps running.
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

    launchctl load "$PLIST_PATH"
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
            print_error "Check: tail -f $LOGS_DIR/stderr.log"
            return 1
        fi
    fi
}

cmd_stop() {
    print_status "Stopping $SERVICE_NAME..."

    # `unload` operates on the launchd registration, not on liveness — so use
    # is_registered (alive-or-dead) here. Otherwise a STALE service couldn't
    # be cleaned up, which is exactly the situation we want stop to handle.
    if ! is_registered; then
        print_warning "Service is not running (LaunchAgent)"
    else
        launchctl unload "$PLIST_PATH"
        sleep 2

        if ! is_registered; then
            print_success "Service stopped (LaunchAgent)"
        else
            print_error "Failed to stop service via LaunchAgent"
        fi
    fi

    # Fallback: kill any process tracked by PID lock file (Issue #152)
    # Catches processes started outside LaunchAgent (e.g., manual node execution)
    local pid_file="$PROJECT_DIR/data/soma-work.pid"
    if [[ -f "$pid_file" ]]; then
        local pid raw
        # The app writes the lock as "<pid>:<ts>"; strip the timestamp suffix.
        # Without this, kill -0 sees a non-numeric arg and the fallback never
        # actually terminates a process started outside launchd (e.g. the
        # headless direct-spawn), which would orphan it across deploys.
        raw=$(cat "$pid_file" 2>/dev/null)
        pid="${raw%%:*}"
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            print_status "Found running process via PID file (pid=$pid), sending SIGTERM..."
            kill "$pid" 2>/dev/null
            sleep 2
            if kill -0 "$pid" 2>/dev/null; then
                print_warning "Process still alive, sending SIGKILL..."
                kill -9 "$pid" 2>/dev/null
                sleep 1
            fi
            if kill -0 "$pid" 2>/dev/null; then
                print_error "Failed to kill process (pid=$pid)"
            else
                print_success "Process killed (pid=$pid)"
            fi
        fi
        rm -f "$pid_file"
    fi
}

cmd_restart() {
    print_status "Restarting $SERVICE_NAME..."
    cmd_stop
    sleep 1
    cmd_start
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

    launchctl load "$PLIST_PATH"
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
    launchctl load "$PLIST_PATH"
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
        echo "  stop         Stop the service"
        echo "  restart      Restart (no rebuild)"
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
        echo "  ./scripts/service.sh main logs history ERROR  # Search live + rotated logs"
        echo "  ./scripts/service.sh status-all           # All environments"
        echo ""
        echo "Deployment: Push to dev/main branch triggers CI auto-deploy"
        ;;
esac
