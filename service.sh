#!/bin/bash

# Claude Code Slack Bot - Service Management Script
# Usage: ./service.sh [status|start|stop|restart|install|uninstall|logs]
#
# This script manages the bot as a SYSTEM DAEMON (/Library/LaunchDaemons)
# which runs at boot time WITHOUT requiring user login.
# All commands require sudo (password will be prompted).

SERVICE_NAME="com.dd.claude-slack-bot"
# Use system-level LaunchDaemons for boot-time execution (no login required)
PLIST_PATH="/Library/LaunchDaemons/$SERVICE_NAME.plist"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOGS_DIR="$PROJECT_DIR/logs"
NODE_PATH="$HOME/.nvm/versions/node/v25.2.1/bin"
USER_HOME="$HOME"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Check if service is running (system-level daemon)
is_running() {
    sudo launchctl list | grep -q "$SERVICE_NAME"
    return $?
}

# Get service PID
get_pid() {
    sudo launchctl list | grep "$SERVICE_NAME" | awk '{print $1}'
}

# Status command
cmd_status() {
    echo "=================================="
    echo "Claude Code Slack Bot - Status"
    echo "=================================="

    if is_running; then
        local pid=$(get_pid)
        print_success "Service is RUNNING (PID: $pid)"

        # Show uptime if possible
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
    echo "Plist: $PLIST_PATH"
    echo "Logs: $LOGS_DIR"

    # Check if plist exists
    if [[ -f "$PLIST_PATH" ]]; then
        echo ""
        echo "Plist file: EXISTS"
    else
        echo ""
        print_warning "Plist file: NOT FOUND"
    fi

    # Show recent log activity
    echo ""
    echo "Recent stderr (last 5 lines):"
    echo "---"
    tail -5 "$LOGS_DIR/stderr.log" 2>/dev/null || echo "  (no logs)"
}

# Start command
cmd_start() {
    print_status "Starting service..."

    if is_running; then
        print_warning "Service is already running"
        return 0
    fi

    if [[ ! -f "$PLIST_PATH" ]]; then
        print_error "Plist not found. Run './service.sh install' first."
        return 1
    fi

    sudo launchctl load "$PLIST_PATH"
    sleep 2

    if is_running; then
        print_success "Service started successfully"
        local pid=$(get_pid)
        echo "  PID: $pid"
    else
        print_error "Failed to start service. Check logs:"
        echo "  tail -f $LOGS_DIR/stderr.log"
        return 1
    fi
}

# Stop command
cmd_stop() {
    print_status "Stopping service..."

    if ! is_running; then
        print_warning "Service is not running"
        return 0
    fi

    sudo launchctl unload "$PLIST_PATH"
    sleep 2

    if ! is_running; then
        print_success "Service stopped successfully"
    else
        print_error "Failed to stop service"
        return 1
    fi
}

# Restart command
cmd_restart() {
    print_status "Restarting service..."
    cmd_stop
    sleep 1
    cmd_start
}

# Install command
cmd_install() {
    print_status "Installing service as system daemon (runs at boot, no login required)..."

    # Create logs directory
    mkdir -p "$LOGS_DIR"

    # Get current user info for running the service
    local CURRENT_USER=$(whoami)
    local CURRENT_UID=$(id -u)
    local CURRENT_GID=$(id -g)

    # Create plist file (requires sudo for /Library/LaunchDaemons)
    sudo tee "$PLIST_PATH" > /dev/null << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_NAME</string>

    <key>UserName</key>
    <string>$CURRENT_USER</string>

    <key>GroupName</key>
    <string>staff</string>

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

    print_success "Plist created at: $PLIST_PATH"

    # Load the service
    sudo launchctl load "$PLIST_PATH"
    sleep 2

    if is_running; then
        print_success "Service installed and started"
        local pid=$(get_pid)
        echo "  PID: $pid"
    else
        print_warning "Service installed but not running. Check logs."
    fi
}

# Uninstall command
cmd_uninstall() {
    print_status "Uninstalling service..."

    if is_running; then
        print_status "Stopping service first..."
        sudo launchctl unload "$PLIST_PATH"
        sleep 2
    fi

    if [[ -f "$PLIST_PATH" ]]; then
        sudo rm "$PLIST_PATH"
        print_success "Plist removed"
    else
        print_warning "Plist not found"
    fi

    print_success "Service uninstalled"
    echo ""
    print_status "Logs preserved at: $LOGS_DIR"
    echo "  To remove logs: rm -rf $LOGS_DIR"
}

# Logs command
cmd_logs() {
    local log_type="${1:-stderr}"
    local lines="${2:-50}"

    case "$log_type" in
        stdout|out)
            echo "=== stdout.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stdout.log"
            ;;
        stderr|err)
            echo "=== stderr.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stderr.log"
            ;;
        follow|f)
            echo "=== Following stderr.log (Ctrl+C to stop) ==="
            tail -f "$LOGS_DIR/stderr.log"
            ;;
        all)
            echo "=== stdout.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stdout.log"
            echo ""
            echo "=== stderr.log (last $lines lines) ==="
            tail -n "$lines" "$LOGS_DIR/stderr.log"
            ;;
        *)
            echo "Usage: ./service.sh logs [stdout|stderr|follow|all] [lines]"
            ;;
    esac
}

# Reinstall command (stop -> build -> install -> start)
cmd_reinstall() {
    print_status "Reinstalling service with latest code..."
    echo ""

    # Step 1: Stop service
    print_status "[1/4] Stopping service..."
    if is_running; then
        sudo launchctl unload "$PLIST_PATH"
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
    cd "$PROJECT_DIR" || exit 1
    if npm run build; then
        print_success "Build completed"
    else
        print_error "Build failed"
        return 1
    fi

    # Step 3: Reinstall plist (in case config changed)
    print_status "[3/4] Updating service configuration..."
    local CURRENT_USER=$(whoami)

    sudo tee "$PLIST_PATH" > /dev/null << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_NAME</string>

    <key>UserName</key>
    <string>$CURRENT_USER</string>

    <key>GroupName</key>
    <string>staff</string>

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
    print_success "Service configuration updated"

    # Step 4: Start service
    print_status "[4/4] Starting service..."
    sudo launchctl load "$PLIST_PATH"
    sleep 2

    if is_running; then
        local pid=$(get_pid)
        echo ""
        print_success "Reinstall completed successfully!"
        echo "  PID: $pid"
        echo ""
        echo "Check logs: ./service.sh logs follow"
    else
        print_error "Service failed to start. Check logs:"
        echo "  tail -f $LOGS_DIR/stderr.log"
        return 1
    fi
}

# Main
case "${1:-}" in
    status)
        cmd_status
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
    logs)
        cmd_logs "$2" "$3"
        ;;
    *)
        echo "Claude Code Slack Bot - Service Manager"
        echo ""
        echo "Usage: ./service.sh <command>"
        echo ""
        echo "Commands:"
        echo "  status     Show service status"
        echo "  start      Start the service"
        echo "  stop       Stop the service"
        echo "  restart    Restart the service (quick, no rebuild)"
        echo "  reinstall  Stop, rebuild, and start (use after code changes)"
        echo "  install    Install as launchd service"
        echo "  uninstall  Remove launchd service"
        echo "  logs       View logs (stdout|stderr|follow|all) [lines]"
        echo ""
        echo "Examples:"
        echo "  ./service.sh status"
        echo "  ./service.sh reinstall    # Apply code changes"
        echo "  ./service.sh logs stderr 100"
        echo "  ./service.sh logs follow"
        ;;
esac
