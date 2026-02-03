#!/bin/bash
# Step 07: Deploy Directories
# Creates /opt/soma-work/{main,dev} deployment directories.

run_step() {
    step_header "07" "Deploy Directories"

    if ! should_run_step "07" "Deploy directories configured"; then
        return 0
    fi

    echo -e "Deployment directories hold separate instances for production and development."
    echo -e "  Production:  ${CYAN}/opt/soma-work/main${NC}  (branch: main)"
    echo -e "  Development: ${CYAN}/opt/soma-work/dev${NC}   (branch: develop)"
    echo ""

    local envs_to_setup=()

    if ask_confirm "Setup production environment (main)?" "Y"; then
        envs_to_setup+=("main")
    fi

    if ask_confirm "Setup development environment (dev)?" "Y"; then
        envs_to_setup+=("dev")
    fi

    if [[ ${#envs_to_setup[@]} -eq 0 ]]; then
        warn "No environments selected. You can set them up later with:"
        echo -e "  ${CYAN}./service.sh main setup${NC}"
        echo -e "  ${CYAN}./service.sh dev setup${NC}"
        mark_step_done "07"
        return 0
    fi

    local service_sh="$REPO_DIR/service.sh"

    for env in "${envs_to_setup[@]}"; do
        local dir="/opt/soma-work/$env"
        echo ""
        info "Setting up $env at $dir..."

        if [[ -d "$dir/.git" ]]; then
            success "$dir already exists (git repo found)"
            # Still do npm ci + build for updates
            if ask_confirm "  Update dependencies and rebuild?" "Y"; then
                cd "$dir" || continue
                local branch="main"
                [[ "$env" == "dev" ]] && branch="develop"
                git fetch origin "$branch" 2>/dev/null || true
                git reset --hard "origin/$branch" 2>/dev/null || true
                npm ci
                npm run build
                success "  $env updated and rebuilt"
            fi
        else
            # Create /opt/soma-work if needed (requires sudo once)
            if [[ ! -d "/opt/soma-work" ]]; then
                info "Creating /opt/soma-work (requires sudo)..."
                sudo mkdir -p /opt/soma-work
                sudo chown "$(whoami):staff" /opt/soma-work
            fi

            if [[ ! -d "$dir" ]]; then
                mkdir -p "$dir"
            fi

            # Clone
            local repo_url
            repo_url=$(get_state "repo_url")
            if [[ -z "$repo_url" ]]; then
                repo_url=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null)
            fi

            # Strip embedded tokens from URL for clean clone
            local clean_url
            clean_url=$(echo "$repo_url" | sed 's|https://[^@]*@|https://|')

            info "Cloning $clean_url into $dir..."
            git clone "$clean_url" "$dir"

            cd "$dir" || continue
            local branch="main"
            [[ "$env" == "dev" ]] && branch="develop"
            git checkout "$branch" 2>/dev/null || git checkout -b "$branch"

            info "Installing dependencies..."
            npm ci

            info "Building..."
            npm run build

            mkdir -p "$dir/logs"
            mkdir -p "$dir/data"

            success "$env environment ready at $dir"
        fi

        set_state "deploy_${env}" "done"
    done

    set_state "deploy_envs" "$(IFS=','; echo "${envs_to_setup[*]}")"
    mark_step_done "07"
    return 0
}
