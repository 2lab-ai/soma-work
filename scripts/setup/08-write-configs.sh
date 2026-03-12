#!/bin/bash
# Step 08: Write Configs to Deploy Directories
# Copies .env, .system.prompt, mcp-servers.json to each deploy dir.

run_step() {
    step_header "08" "Write Configs to Deploy Directories"

    if ! should_run_step "08" "Configs written to deploy dirs"; then
        return 0
    fi

    local deploy_envs
    deploy_envs=$(get_state "deploy_envs" "")

    if [[ -z "$deploy_envs" ]]; then
        warn "No deploy environments configured. Skipping."
        mark_step_done "08"
        return 0
    fi

    local config_files=(".env" ".system.prompt" "mcp-servers.json")

    for env in $(echo "$deploy_envs" | tr ',' ' '); do
        local dir="/opt/soma-work/$env"

        if [[ ! -d "$dir" ]]; then
            warn "$dir does not exist. Run step 07 first."
            continue
        fi

        echo ""
        info "Writing configs to $dir..."

        for f in "${config_files[@]}"; do
            local src="$REPO_DIR/$f"
            local dst="$dir/$f"

            if [[ ! -f "$src" ]]; then
                warn "  $f not found in repo (skipping)"
                continue
            fi

            if [[ -f "$dst" ]]; then
                # Compare
                if diff -q "$src" "$dst" &>/dev/null; then
                    success "  $f (unchanged)"
                    continue
                fi

                if ask_confirm "  $f differs in $dir. Overwrite?" "Y"; then
                    cp "$src" "$dst"
                    success "  $f updated"
                else
                    info "  $f kept as-is"
                fi
            else
                cp "$src" "$dst"
                success "  $f copied"
            fi

            # Secure .env
            [[ "$f" == ".env" ]] && chmod 600 "$dst"
        done
    done

    mark_step_done "08"
    return 0
}
