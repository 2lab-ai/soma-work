#!/bin/bash
#
# ============================== DEPRECATED ==============================
# UNREACHABLE. Nothing invokes this file.
#
# The only caller was scripts/setup-wizard-macos.sh, which is now a shim that
# `exec somawork setup`. Onboarding is `somawork setup`: it authorizes Slack
# through the Slack CLI and captures the runtime tokens over a profile-scoped
# Unix socket into a 0600 secrets.env — no terminal token prompt, no
# repo-relative .env, no /opt materialization.
#
# This directory is excluded from the runtime bundle
# (scripts/deploy/stage-bundle.sh; enforced by scripts/smoke/setup-package.js)
# and is scheduled for DELETION once the clean-machine receipt for
# `somawork setup` is green. Do not extend it, and do not wire a new caller.
# ========================================================================

# Mechanical enforcement of the banner above. The comment asserted
# unreachability; this makes it true for both entry paths -- direct execution
# and `source`. The credential-collecting bodies below are still live code, and
# these files survive until the clean-machine receipt, so the invariant is
# enforced rather than described.
printf '%s\n' "$(basename "${BASH_SOURCE[0]:-$0}") is deprecated and unreachable; run \`somawork setup\`." >&2
return 1 2>/dev/null || exit 1
# Step 07: Deploy Directories
# Creates /opt/soma-work/{main,dev} deployment directories.

run_step() {
    step_header "07" "Deploy Directories"

    if ! should_run_step "07" "Deploy directories configured"; then
        return 0
    fi

    echo -e "Deployment directories hold separate instances for production and development."
    echo -e "  Production:  ${CYAN}/opt/soma-work/main${NC}  (branch: deploy/prod)"
    echo -e "  Development: ${CYAN}/opt/soma-work/dev${NC}   (branch: main)"
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
        echo -e "  ${CYAN}./scripts/service.sh main setup${NC}"
        echo -e "  ${CYAN}./scripts/service.sh dev setup${NC}"
        mark_step_done "07"
        return 0
    fi

    local service_sh="$REPO_DIR/scripts/service.sh"

    for env in "${envs_to_setup[@]}"; do
        local dir="/opt/soma-work/$env"
        echo ""
        info "Setting up $env at $dir..."

        if [[ -d "$dir/.git" ]]; then
            success "$dir already exists (git repo found)"
            # Still do npm ci + build for updates
            if ask_confirm "  Update dependencies and rebuild?" "Y"; then
                cd "$dir" || continue
                local branch="deploy/prod"
                [[ "$env" == "dev" ]] && branch="main"
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
            local branch="deploy/prod"
            [[ "$env" == "dev" ]] && branch="main"
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
