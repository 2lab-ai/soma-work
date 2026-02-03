#!/bin/bash

# soma-work - Service Management Script
# Usage: ./service.sh [env] <command>
#
# Environments:
#   main    /opt/soma-work/main (production)
#   dev     /opt/soma-work/dev (development)
#   (none)  Current directory (local dev)
#
# Uses LaunchAgents (user-level) for service management.
# No sudo required. Service starts when user logs in.

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
            PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
            ;;
    esac

    PLIST_PATH="$LAUNCH_AGENTS_DIR/$SERVICE_NAME.plist"
    LOGS_DIR="$PROJECT_DIR/logs"
    NODE_PATH="$HOME/.nvm/versions/node/v25.2.1/bin"
    USER_HOME="$HOME"
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
is_running() {
    launchctl list 2>/dev/null | grep -q "$SERVICE_NAME"
}

get_pid() {
    launchctl list 2>/dev/null | grep "$SERVICE_NAME" | awk '{print $1}'
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
        <string>export PATH=$NODE_PATH:\$PATH; cd $PROJECT_DIR; npx tsx src/index.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_PATH:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$USER_HOME</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$LOGS_DIR/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>$LOGS_DIR/stderr.log</string>

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

    if is_running; then
        local pid=$(get_pid)
        print_success "Service is RUNNING (PID: $pid)"

        if [[ "$pid" != "-" && "$pid" != "" ]]; then
            local start_time=$(ps -p "$pid" -o lstart= 2>/dev/null)
            if [[ -n "$start_time" ]]; then
                echo "  Started: $start_time"
            fi
        fi
    else
        print_warning "Service is STOPPED"
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
}

cmd_start() {
    print_status "Starting $SERVICE_NAME..."

    if is_running; then
        print_warning "Service is already running"
        return 0
    fi

    if [[ ! -f "$PLIST_PATH" ]]; then
        print_error "Plist not found. Run './service.sh ${ENV_ARG:+$ENV_ARG }install' first."
        return 1
    fi

    launchctl load "$PLIST_PATH"
    sleep 2

    if is_running; then
        print_success "Service started (PID: $(get_pid))"
    else
        print_error "Failed to start. Check: tail -f $LOGS_DIR/stderr.log"
        return 1
    fi
}

cmd_stop() {
    print_status "Stopping $SERVICE_NAME..."

    if ! is_running; then
        print_warning "Service is not running"
        return 0
    fi

    launchctl unload "$PLIST_PATH"
    sleep 2

    if ! is_running; then
        print_success "Service stopped"
    else
        print_error "Failed to stop service"
        return 1
    fi
}

cmd_restart() {
    print_status "Restarting $SERVICE_NAME..."
    cmd_stop
    sleep 1
    cmd_start
}

cmd_install() {
    print_status "Installing $SERVICE_NAME as LaunchAgent..."

    if [[ ! -d "$PROJECT_DIR" ]]; then
        print_error "Project directory not found: $PROJECT_DIR"
        print_status "Run './service.sh ${ENV_ARG:+$ENV_ARG }setup' first."
        return 1
    fi

    mkdir -p "$LOGS_DIR"
    mkdir -p "$LAUNCH_AGENTS_DIR"

    generate_plist > "$PLIST_PATH"
    print_success "Plist created: $PLIST_PATH"

    launchctl load "$PLIST_PATH"
    sleep 2

    if is_running; then
        print_success "Service installed and started (PID: $(get_pid))"
    else
        print_warning "Service installed but not running. Check logs."
    fi
}

cmd_uninstall() {
    print_status "Uninstalling $SERVICE_NAME..."

    if is_running; then
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
            echo "=== Following $SERVICE_NAME stderr.log (Ctrl+C to stop) ==="
            tail -f "$LOGS_DIR/stderr.log"
            ;;
        all)
            echo "=== $SERVICE_NAME stdout.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stdout.log"
            echo ""
            echo "=== $SERVICE_NAME stderr.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stderr.log"
            ;;
        *)
            echo "Usage: ./service.sh [env] logs [stdout|stderr|follow|all] [lines]"
            ;;
    esac
}

cmd_reinstall() {
    print_status "Reinstalling $SERVICE_NAME..."
    echo ""

    # Step 1: Stop
    print_status "[1/4] Stopping service..."
    if is_running; then
        launchctl unload "$PLIST_PATH"
        sleep 2
        if ! is_running; then
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

    if is_running; then
        echo ""
        print_success "Reinstall completed! (PID: $(get_pid))"
        echo "  Check logs: ./service.sh ${ENV_ARG:+$ENV_ARG }logs follow"
    else
        print_error "Service failed to start. Check: tail -f $LOGS_DIR/stderr.log"
        return 1
    fi
}

# Setup deployment directory (only for main/dev environments)
cmd_setup() {
    if [[ -z "$ENV_ARG" ]]; then
        print_error "Setup requires an environment: ./service.sh main setup  or  ./service.sh dev setup"
        return 1
    fi

    print_status "Setting up $ENV_ARG environment at $PROJECT_DIR..."

    # Create directory (needs sudo for /opt)
    if [[ ! -d "$PROJECT_DIR" ]]; then
        sudo mkdir -p "$PROJECT_DIR"
        sudo chown "$(whoami):staff" "$PROJECT_DIR"
    fi

    # Clone or init
    if [[ ! -d "$PROJECT_DIR/.git" ]]; then
        print_status "Cloning repository..."
        local REPO_URL
        REPO_URL=$(git -C "$(cd "$(dirname "$0")" && pwd)" remote get-url origin 2>/dev/null | sed 's|https://[^@]*@|https://|')
        if [[ -z "$REPO_URL" ]]; then
            print_error "Cannot determine repo URL. Clone manually into $PROJECT_DIR"
            return 1
        fi
        git clone "$REPO_URL" "$PROJECT_DIR"
    fi

    # Checkout appropriate branch
    local branch="main"
    [[ "$ENV_ARG" == "dev" ]] && branch="develop"
    cd "$PROJECT_DIR" || return 1
    git checkout "$branch" 2>/dev/null || git checkout -b "$branch"
    git pull origin "$branch" 2>/dev/null || true

    # Install dependencies
    print_status "Installing dependencies..."
    npm ci

    # Build
    print_status "Building..."
    npm run build

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

    echo ""
    print_success "Setup complete for $ENV_ARG at $PROJECT_DIR"
    print_status "Next: Copy .env and .system.prompt, then run: ./service.sh $ENV_ARG install"
}

# Deploy command (used by GitHub Actions)
cmd_deploy() {
    if [[ -z "$ENV_ARG" ]]; then
        print_error "Deploy requires an environment: ./service.sh main deploy  or  ./service.sh dev deploy"
        return 1
    fi

    print_status "Deploying $ENV_ARG..."
    echo ""

    cd "$PROJECT_DIR" || return 1

    # Step 1: Pull latest code
    print_status "[1/4] Pulling latest code..."
    local branch="main"
    [[ "$ENV_ARG" == "dev" ]] && branch="develop"
    git fetch origin "$branch"
    git reset --hard "origin/$branch"
    print_success "Code updated"

    # Step 2: Install dependencies
    print_status "[2/4] Installing dependencies..."
    npm ci
    print_success "Dependencies installed"

    # Step 3: Build
    print_status "[3/4] Building..."
    npm run build
    print_success "Build completed"

    # Step 4: Restart service
    print_status "[4/4] Restarting service..."
    if is_running; then
        launchctl unload "$PLIST_PATH"
        sleep 2
    fi
    launchctl load "$PLIST_PATH"
    sleep 3

    if is_running; then
        echo ""
        print_success "Deploy completed! (PID: $(get_pid))"
    else
        print_error "Service failed to start after deploy"
        tail -10 "$LOGS_DIR/stderr.log"
        return 1
    fi
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
    deploy)
        cmd_deploy
        ;;
    logs)
        cmd_logs "$1" "$2"
        ;;
    *)
        echo "soma-work - Service Manager"
        echo ""
        echo "Usage: ./service.sh [env] <command> [args]"
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
        echo "  setup        Initialize deployment directory (main/dev only)"
        echo "  deploy       Pull, build, restart (used by CI)"
        echo "  logs         View logs [stdout|stderr|follow|all] [lines]"
        echo ""
        echo "Examples:"
        echo "  ./service.sh status              # Local status"
        echo "  ./service.sh main status          # Production status"
        echo "  ./service.sh dev setup            # Initialize dev environment"
        echo "  ./service.sh main deploy          # Deploy production"
        echo "  ./service.sh main logs follow     # Stream production logs"
        echo "  ./service.sh status-all           # All environments"
        ;;
esac
