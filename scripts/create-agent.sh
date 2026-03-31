#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# create-agent.sh — Semi-automated sub-agent creation
#
# Usage:
#   ./scripts/create-agent.sh <agent-name> [description]
#
# Example:
#   ./scripts/create-agent.sh jangbi "코드 리뷰 전문 에이전트"
#   ./scripts/create-agent.sh gwanu "배포 및 인프라 전문 에이전트"
#
# What it does:
#   1. Generates a Slack App manifest JSON for the agent
#   2. Creates prompt directory with default prompt
#   3. Opens Slack App creation URL (or prints it)
#   4. Prompts you to paste tokens
#   5. Updates config.json automatically
# ─────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/config.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
err()   { echo -e "${RED}✗${NC}  $*" >&2; }
step()  { echo -e "\n${BOLD}${CYAN}── Step $1 ──${NC}"; }

# ── Args ─────────────────────────────────────────────────
AGENT_NAME="${1:-}"
DESCRIPTION="${2:-AI Agent}"

if [[ -z "$AGENT_NAME" ]]; then
  err "Usage: $0 <agent-name> [description]"
  err "Example: $0 jangbi '코드 리뷰 전문 에이전트'"
  exit 1
fi

# Validate agent name (alphanumeric + hyphen only)
if [[ ! "$AGENT_NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  err "Agent name must be lowercase alphanumeric (a-z, 0-9, -), starting with a letter"
  exit 1
fi

DISPLAY_NAME="soma-${AGENT_NAME}"
MANIFEST_FILE="$PROJECT_ROOT/slack-app-manifest-${AGENT_NAME}.json"
PROMPT_DIR="$PROJECT_ROOT/src/prompt/${AGENT_NAME}"

echo ""
echo -e "${BOLD}🤖 Creating Sub-Agent: ${AGENT_NAME}${NC}"
echo -e "   Display Name: ${DISPLAY_NAME}"
echo -e "   Description:  ${DESCRIPTION}"
echo ""

# ── Step 1: Generate Manifest ────────────────────────────
step "1/4: Generate Slack App Manifest"

cat > "$MANIFEST_FILE" << MANIFEST_EOF
{
  "display_information": {
    "name": "${DISPLAY_NAME}",
    "description": "${DESCRIPTION}",
    "background_color": "#4A154B",
    "long_description": "Sub-agent for soma-work multi-agent system. This agent has its own persona and specialization."
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "${DISPLAY_NAME}",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "users:read",
        "reactions:read",
        "reactions:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
MANIFEST_EOF

ok "Manifest generated: $MANIFEST_FILE"

# ── Step 2: Create Prompt Directory ──────────────────────
step "2/4: Create Agent Prompt Directory"

if [[ -d "$PROMPT_DIR" ]]; then
  warn "Prompt directory already exists: $PROMPT_DIR"
else
  mkdir -p "$PROMPT_DIR"
  cat > "$PROMPT_DIR/default.prompt" << PROMPT_EOF
# ${AGENT_NAME} — Sub-Agent System Prompt

${DESCRIPTION}

{{include:../common.prompt}}
PROMPT_EOF
  ok "Created prompt: $PROMPT_DIR/default.prompt"
  info "Edit this file to customize the agent's personality and expertise."
fi

# ── Step 3: Create Slack App ─────────────────────────────
step "3/4: Create Slack App"

# Encode manifest for URL
MANIFEST_URL_ENCODED=$(python3 -c "
import json, urllib.parse
with open('${MANIFEST_FILE}') as f:
    manifest = json.load(f)
print(urllib.parse.quote(json.dumps(manifest)))
" 2>/dev/null || echo "")

if [[ -n "$MANIFEST_URL_ENCODED" ]]; then
  CREATE_URL="https://api.slack.com/apps?new_app=1&manifest_json=${MANIFEST_URL_ENCODED}"
  info "Open this URL in your browser to create the Slack App:"
  echo ""
  echo -e "  ${BOLD}${CYAN}${CREATE_URL}${NC}"
  echo ""

  # Try to open in browser (macOS)
  if command -v open &>/dev/null; then
    read -r -p "  Open in browser now? [Y/n] " OPEN_BROWSER
    OPEN_BROWSER="${OPEN_BROWSER:-Y}"
    if [[ "$OPEN_BROWSER" =~ ^[Yy] ]]; then
      open "$CREATE_URL" 2>/dev/null || true
    fi
  fi
else
  warn "Could not generate URL. Create the app manually:"
  echo "  1. Go to https://api.slack.com/apps"
  echo "  2. Click 'Create New App' → 'From an app manifest'"
  echo "  3. Select your workspace"
  echo "  4. Paste contents of: $MANIFEST_FILE"
fi

echo ""
info "After creating the app, you need 3 tokens:"
echo "  1. ${BOLD}Bot Token${NC} (xoxb-...): OAuth & Permissions → Bot User OAuth Token"
echo "  2. ${BOLD}App Token${NC} (xapp-...): Socket Mode → Generate App-Level Token (scope: connections:write)"
echo "  3. ${BOLD}Signing Secret${NC}: Basic Information → App Credentials → Signing Secret"
echo ""

# ── Step 4: Collect Tokens & Update Config ───────────────
step "4/4: Configure Tokens"

read -r -p "  Bot Token (xoxb-...): " BOT_TOKEN
read -r -p "  App Token (xapp-...): " APP_TOKEN
read -r -p "  Signing Secret: " SIGNING_SECRET

# Validate tokens
VALID=true
if [[ ! "$BOT_TOKEN" =~ ^xoxb- ]]; then
  err "Bot Token must start with xoxb-"
  VALID=false
fi
if [[ ! "$APP_TOKEN" =~ ^xapp- ]]; then
  err "App Token must start with xapp-"
  VALID=false
fi
if [[ ${#SIGNING_SECRET} -lt 20 ]]; then
  err "Signing Secret seems too short (< 20 chars)"
  VALID=false
fi

if [[ "$VALID" != "true" ]]; then
  err "Token validation failed. Fix the values and re-run, or edit config.json manually."
  exit 1
fi

# Update config.json
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo '{}' > "$CONFIG_FILE"
fi

# Use python to safely merge into config.json
python3 << PYEOF
import json, sys

config_path = "${CONFIG_FILE}"
agent_name = "${AGENT_NAME}"

with open(config_path, 'r') as f:
    config = json.load(f)

if 'agents' not in config:
    config['agents'] = {}

config['agents'][agent_name] = {
    "slackBotToken": "${BOT_TOKEN}",
    "slackAppToken": "${APP_TOKEN}",
    "signingSecret": "${SIGNING_SECRET}",
    "promptDir": "src/prompt/${AGENT_NAME}",
    "description": "${DESCRIPTION}"
}

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(f"  ✓ config.json updated with agent '{agent_name}'")
PYEOF

# ── Done ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  Agent '${AGENT_NAME}' setup complete!  ${NC}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo "  Next steps:"
echo "  1. Edit the agent prompt: ${PROMPT_DIR}/default.prompt"
echo "  2. Restart soma-work:     service.sh restart"
echo "  3. Test: @${DISPLAY_NAME} 안녕!"
echo ""
echo "  To add more agents, run this script again with a different name."
echo ""

# Clean up manifest (it contains no secrets, but not needed after creation)
read -r -p "  Delete manifest file? [y/N] " DELETE_MANIFEST
if [[ "$DELETE_MANIFEST" =~ ^[Yy] ]]; then
  rm -f "$MANIFEST_FILE"
  ok "Manifest deleted"
fi
