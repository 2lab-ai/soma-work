#!/bin/bash
# Step 02: Slack App Setup
# Guides user through creating a Slack app and collecting tokens.

run_step() {
    step_header "02" "Slack App Setup"

    if ! should_run_step "02" "Slack App configured"; then
        return 0
    fi

    echo -e "You need a Slack App with Socket Mode enabled."
    echo ""
    echo -e "${BOLD}Quick setup:${NC}"
    echo -e "  1. Go to ${CYAN}https://api.slack.com/apps${NC}"
    echo -e "  2. Click ${BOLD}Create New App${NC} → ${BOLD}From a manifest${NC}"
    echo -e "  3. Paste the contents of ${CYAN}slack-app-manifest.yaml${NC} from this repo"
    echo -e "  4. After creating, go to:"
    echo -e "     - ${BOLD}OAuth & Permissions${NC} → Copy Bot User OAuth Token (xoxb-...)"
    echo -e "     - ${BOLD}Basic Information${NC}  → App-Level Tokens → Create one with"
    echo -e "       ${DIM}connections:write${NC} scope (xapp-...)"
    echo -e "     - ${BOLD}Basic Information${NC}  → Signing Secret"
    echo ""
    echo -e "${DIM}Tip: For separate dev/prod, create 2 Slack Apps with different names.${NC}"
    echo ""

    # Collect tokens
    # For re-runs, check if .env already has values
    local existing_bot_token=""
    local existing_app_token=""
    local existing_signing_secret=""

    if [[ -f "$REPO_DIR/.env" ]]; then
        existing_bot_token=$(grep "^SLACK_BOT_TOKEN=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
        existing_app_token=$(grep "^SLACK_APP_TOKEN=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
        existing_signing_secret=$(grep "^SLACK_SIGNING_SECRET=" "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
    fi

    local bot_token app_token signing_secret

    bot_token=$(ask_secret "SLACK_BOT_TOKEN (xoxb-...)" "$(mask_secret "$existing_bot_token" 10)")
    bot_token="${bot_token:-$existing_bot_token}"

    app_token=$(ask_secret "SLACK_APP_TOKEN (xapp-...)" "$(mask_secret "$existing_app_token" 10)")
    app_token="${app_token:-$existing_app_token}"

    signing_secret=$(ask_secret "SLACK_SIGNING_SECRET" "$(mask_secret "$existing_signing_secret" 8)")
    signing_secret="${signing_secret:-$existing_signing_secret}"

    # Validate
    if [[ -z "$bot_token" || -z "$app_token" || -z "$signing_secret" ]]; then
        error "All three Slack tokens are required."
        return 1
    fi

    if [[ ! "$bot_token" == xoxb-* ]]; then
        warn "Bot token doesn't start with 'xoxb-'. Double-check."
    fi
    if [[ ! "$app_token" == xapp-* ]]; then
        warn "App token doesn't start with 'xapp-'. Double-check."
    fi

    # Store in temp vars (will be written to .env in step 04)
    set_state "has_slack_tokens" "true"

    # Write tokens to a temp file for step 04 to pick up
    # (We don't store secrets in .setup-state)
    local secrets_tmp="$REPO_DIR/.setup-secrets.tmp"
    cat > "$secrets_tmp" << EOF
SLACK_BOT_TOKEN=$bot_token
SLACK_APP_TOKEN=$app_token
SLACK_SIGNING_SECRET=$signing_secret
EOF
    chmod 600 "$secrets_tmp"

    success "Slack tokens collected"
    mark_step_done "02"
    return 0
}
