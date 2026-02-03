#!/bin/bash
# Step 11: Service Install
# Installs LaunchAgents for main/dev environments via service.sh.

run_step() {
    step_header "11" "Service Install"

    if ! should_run_step "11" "Services installed"; then
        return 0
    fi

    local deploy_envs
    deploy_envs=$(get_state "deploy_envs" "")

    if [[ -z "$deploy_envs" ]]; then
        warn "No deploy environments configured. Skipping service install."
        echo -e "  ${DIM}Install manually: ./service.sh main install${NC}"
        mark_step_done "11"
        return 0
    fi

    local service_sh="$REPO_DIR/service.sh"

    for env in $(echo "$deploy_envs" | tr ',' ' '); do
        local dir="/opt/soma-work/$env"
        local plist="$HOME/Library/LaunchAgents/ai.2lab.soma-work.${env}.plist"

        echo ""
        info "Installing $env service..."

        if [[ ! -d "$dir" ]]; then
            warn "  $dir not found. Skipping."
            continue
        fi

        # Check if .env exists in deploy dir
        if [[ ! -f "$dir/.env" ]]; then
            warn "  $dir/.env not found. Service will fail without it."
            echo -e "  Run step 08 first, or copy manually."
            continue
        fi

        if [[ -f "$plist" ]]; then
            # Already installed -- restart
            info "  LaunchAgent exists, restarting..."
            launchctl unload "$plist" 2>/dev/null || true
            sleep 1
        fi

        # Use service.sh to install
        bash "$service_sh" "$env" install
        sleep 2

        # Check if running
        if launchctl list 2>/dev/null | grep -q "ai.2lab.soma-work.${env}"; then
            local pid
            pid=$(launchctl list 2>/dev/null | grep "ai.2lab.soma-work.${env}" | awk '{print $1}')
            success "  $env service running (PID: $pid)"
        else
            warn "  $env service installed but not running. Check logs:"
            echo -e "    ${CYAN}./service.sh $env logs stderr${NC}"
        fi

        set_state "service_${env}" "installed"
    done

    mark_step_done "11"
    return 0
}
