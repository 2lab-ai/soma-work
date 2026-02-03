#!/bin/bash
# Step 12: Verification
# Final health check of all configured components.

run_step() {
    step_header "12" "Verification"

    echo -e "Running final checks...\n"

    local all_ok=true

    # --- Node.js path in service.sh ---
    local node_path
    node_path=$(detect_node_path)
    local service_sh="$REPO_DIR/service.sh"

    if [[ -n "$node_path" ]]; then
        local current_node_path
        current_node_path=$(grep 'NODE_PATH=' "$service_sh" | head -1 | sed 's/.*NODE_PATH="//' | sed 's/".*//' | sed "s|.*=||" | sed "s|\$HOME|$HOME|g")

        if [[ "$current_node_path" != *"$node_path"* ]]; then
            info "Updating Node.js path in service.sh..."
            # Update the NODE_PATH line
            sed -i '' "s|NODE_PATH=.*|NODE_PATH=\"$node_path\"|" "$service_sh"
            success "Node path updated: $node_path"
        else
            success "Node path correct: $node_path"
        fi
    fi

    # --- Deploy directories ---
    local deploy_envs
    deploy_envs=$(get_state "deploy_envs" "")

    for env in $(echo "$deploy_envs" | tr ',' ' '); do
        local dir="/opt/soma-work/$env"
        echo ""
        info "Checking $env environment..."

        if [[ -d "$dir" ]]; then
            success "  Directory: $dir"
        else
            error "  Directory missing: $dir"
            all_ok=false
            continue
        fi

        # Config files
        for f in .env .system.prompt; do
            if [[ -f "$dir/$f" ]]; then
                success "  $f present"
            else
                warn "  $f missing"
            fi
        done

        # Service status
        if launchctl list 2>/dev/null | grep -q "ai.2lab.soma-work.${env}"; then
            local pid
            pid=$(launchctl list 2>/dev/null | grep "ai.2lab.soma-work.${env}" | awk '{print $1}')
            success "  Service running (PID: $pid)"

            # Check recent logs for errors
            local error_count=0
            if [[ -f "$dir/logs/stderr.log" ]]; then
                error_count=$(tail -20 "$dir/logs/stderr.log" 2>/dev/null | grep -c "ERROR" || echo "0")
            fi
            if [[ "$error_count" -gt 0 ]]; then
                warn "  $error_count errors in recent logs"
                echo -e "    ${DIM}Check: ./service.sh $env logs stderr 20${NC}"
            else
                success "  No recent errors in logs"
            fi
        else
            warn "  Service not running"
            echo -e "    ${DIM}Start: ./service.sh $env start${NC}"
        fi
    done

    # --- GitHub runner ---
    local owner_repo
    owner_repo=$(get_state "owner_repo" "")
    if [[ -n "$owner_repo" ]]; then
        echo ""
        info "Checking GitHub Actions runner..."
        local runner_count
        runner_count=$(gh api "repos/$owner_repo/actions/runners" --jq '.total_count' 2>/dev/null || echo "0")
        if [[ "$runner_count" -gt 0 ]]; then
            local runner_info
            runner_info=$(gh api "repos/$owner_repo/actions/runners" --jq '.runners[] | "\(.name) (\(.status))"' 2>/dev/null)
            success "  Runner: $runner_info"
        else
            warn "  No runners registered"
            echo -e "    ${DIM}Run step 10 to install a runner${NC}"
        fi
    fi

    # --- Summary ---
    echo ""
    echo -e "${BOLD}══════════════════════════════════════${NC}"
    echo -e "${BOLD}  Setup Summary${NC}"
    echo -e "${BOLD}══════════════════════════════════════${NC}"
    echo ""

    # Count completed steps
    local completed=0
    for s in 00 01 02 03 04 05 06 07 08 09 10 11; do
        is_step_done "$s" && ((completed++))
    done
    echo -e "  Steps completed: ${BOLD}$completed/12${NC}"
    echo -e "  Environments:    ${BOLD}${deploy_envs:-none}${NC}"
    echo -e "  GitHub repo:     ${BOLD}${owner_repo:-not set}${NC}"
    echo -e "  Runner:          ${BOLD}$(get_state "runner_name" "not installed")${NC}"
    echo ""

    if $all_ok; then
        success "All checks passed!"
    else
        warn "Some checks failed. Review the output above."
    fi

    mark_step_done "12"
    return 0
}
