#!/bin/bash
# Step 03: GitHub Integration
# Configure GitHub App or Personal Access Token.

run_step() {
    step_header "03" "GitHub Integration"

    if ! should_run_step "03" "GitHub integration configured"; then
        return 0
    fi

    echo -e "GitHub integration enables: git operations, PR creation, repo access."
    echo ""

    local method
    method=$(ask_choice "Authentication method:" \
        "GitHub App (recommended - auto-refreshing tokens)" \
        "Personal Access Token (simpler, manual rotation)" \
        "Skip (no GitHub integration)")

    local secrets_tmp="$REPO_DIR/.setup-secrets.tmp"

    case "$method" in
        "GitHub App"*)
            set_state "github_method" "app"

            echo ""
            echo -e "${BOLD}GitHub App setup:${NC}"
            echo -e "  1. Go to ${CYAN}https://github.com/settings/apps/new${NC}"
            echo -e "  2. Set permissions: Contents (R/W), Pull Requests (R/W), Issues (R/W)"
            echo -e "  3. Install the app on your repo"
            echo -e "  4. Note the App ID, generate a private key, and get the Installation ID"
            echo ""

            # Read existing values
            local existing_app_id="" existing_key="" existing_install_id=""
            if [[ -f "$REPO_DIR/.env" ]]; then
                existing_app_id=$(grep "^GITHUB_APP_ID=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
                existing_install_id=$(grep "^GITHUB_INSTALLATION_ID=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
            fi

            local app_id install_id private_key

            app_id=$(ask_value "GitHub App ID" "github_app_id" "$existing_app_id")
            install_id=$(ask_value "Installation ID" "github_installation_id" "$existing_install_id")

            echo -e "${BOLD}Private Key${NC} (paste the PEM content, then press Enter on an empty line):"
            local key_lines=""
            while IFS= read -r line; do
                [[ -z "$line" ]] && break
                key_lines+="$line\n"
            done

            if [[ -n "$key_lines" ]]; then
                private_key=$(echo -e "$key_lines")
            else
                # Check if existing .env has it
                private_key=$(grep "^GITHUB_PRIVATE_KEY=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- | sed 's/^"//' | sed 's/"$//' || echo "")
                if [[ -n "$private_key" ]]; then
                    success "Keeping existing private key"
                fi
            fi

            if [[ -z "$app_id" || -z "$install_id" ]]; then
                warn "GitHub App ID and Installation ID are required."
                return 1
            fi

            # Append to secrets tmp
            cat >> "$secrets_tmp" << EOF
GITHUB_APP_ID=$app_id
GITHUB_PRIVATE_KEY="$private_key"
GITHUB_INSTALLATION_ID=$install_id
EOF
            success "GitHub App configured (ID: $app_id)"
            ;;

        "Personal Access Token"*)
            set_state "github_method" "pat"

            echo ""
            echo -e "Create a token at: ${CYAN}https://github.com/settings/tokens${NC}"
            echo -e "Required scopes: ${BOLD}repo${NC}, ${BOLD}workflow${NC}"
            echo ""

            local existing_token=""
            if [[ -f "$REPO_DIR/.env" ]]; then
                existing_token=$(grep "^GITHUB_TOKEN=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
            fi

            local token
            token=$(ask_secret "GitHub Token (ghp_...)" "$(mask_secret "$existing_token" 8)")
            token="${token:-$existing_token}"

            if [[ -z "$token" ]]; then
                warn "No token provided."
                return 1
            fi

            cat >> "$secrets_tmp" << EOF
GITHUB_TOKEN=$token
EOF
            success "GitHub PAT configured"
            ;;

        "Skip"*)
            set_state "github_method" "skip"
            success "GitHub integration skipped"
            ;;
    esac

    mark_step_done "03"
    return 0
}
