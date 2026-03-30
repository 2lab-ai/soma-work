#!/bin/bash
# ============================================================================
# soma-work: New Node Deployment Setup
# ============================================================================
#
# 3-Phase 구조:
#   Phase 1: Prerequisites (모든 도구 idempotent 설치)
#   Phase 2: User Input    (로그인, 인증, 환경변수 — 한번에 모두 입력)
#   Phase 3: Unattended    (나머지 전부 자동 — 유저 입력 없음)
#
# Usage:
#   ./scripts/new-deploy-setup.sh
#
# 환경변수로 미리 설정 가능 (Phase 2 입력 건너뜀):
#   DEPLOY_ENV, DEPLOY_BRANCH, REPO, BASE_DIRECTORY
#   SLACK_APP_NAME, BOT_DISPLAY_NAME, BOT_ICON_PATH
#   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
#
# ============================================================================
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[ OK ]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()    { echo -e "${RED}[FAIL]${NC} $1"; }
header()  { echo ""; echo -e "${BOLD}${CYAN}══════════════════════════════════════${NC}"; echo -e "${BOLD}${CYAN}  $1${NC}"; echo -e "${BOLD}${CYAN}══════════════════════════════════════${NC}"; echo ""; }

# --- State file (idempotency) ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_FILE="${REPO_DIR}/.new-deploy-state"

get_state() {
    local key="$1" default="${2:-}"
    local val
    val=$(grep "^${key}=" "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    echo "${val:-$default}"
}

set_state() {
    local key="$1" value="$2"
    [ -f "$STATE_FILE" ] || echo "# new-deploy-setup state" > "$STATE_FILE"
    local tmp="${STATE_FILE}.tmp"
    grep -v "^${key}=" "$STATE_FILE" > "$tmp" 2>/dev/null || true
    echo "${key}=${value}" >> "$tmp"
    mv "$tmp" "$STATE_FILE"
}

is_done() { [ "$(get_state "$1")" = "done" ]; }
mark_done() { set_state "$1" "done"; }

# ============================================================================
# PHASE 1: Prerequisites (idempotent, no user input)
# ============================================================================
phase1_prerequisites() {
    header "Phase 1: Prerequisites"
    info "모든 필수 도구를 idempotent하게 설치합니다..."

    # --- Homebrew ---
    if command -v brew &>/dev/null; then
        success "Homebrew $(brew --version | head -1)"
    else
        info "Homebrew 설치 중..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Apple Silicon PATH
        if [ -f /opt/homebrew/bin/brew ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
        success "Homebrew 설치 완료"
    fi

    # --- Core tools ---
    local tools=("node" "git" "gh" "jq" "curl")
    local brew_pkgs=("node" "git" "gh" "jq" "curl")
    local missing=()

    for i in "${!tools[@]}"; do
        if command -v "${tools[$i]}" &>/dev/null; then
            success "${tools[$i]} $(${tools[$i]} --version 2>/dev/null | head -1)"
        else
            missing+=("${brew_pkgs[$i]}")
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        info "누락된 도구 설치: ${missing[*]}"
        brew install "${missing[@]}"
        success "도구 설치 완료"
    fi

    # --- npm (node 포함) ---
    if ! command -v npm &>/dev/null; then
        fail "npm not found (node 설치 확인)"
        exit 1
    fi

    # --- Slack CLI ---
    if command -v slack &>/dev/null; then
        success "Slack CLI $(slack version 2>/dev/null | head -1)"
    else
        info "Slack CLI 설치 중..."
        curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
        # PATH 추가
        export PATH="$HOME/.slack/bin:$PATH"
        if command -v slack &>/dev/null; then
            success "Slack CLI 설치 완료"
        else
            warn "Slack CLI 설치됐지만 PATH에 없음. ~/.slack/bin/slack 확인"
        fi
    fi

    # --- GitHub Actions Runner directory ---
    local runner_dir="$HOME/actions-runner"
    if [ -f "${runner_dir}/config.sh" ]; then
        success "GitHub Actions Runner 바이너리 존재"
    else
        info "GitHub Actions Runner 다운로드 중..."
        local arch
        arch=$(uname -m)
        local runner_arch
        case "$arch" in
            arm64)  runner_arch="osx-arm64" ;;
            x86_64) runner_arch="osx-x64" ;;
            *)      fail "지원하지 않는 아키텍처: $arch"; exit 1 ;;
        esac

        local latest
        latest=$(curl -sL "https://api.github.com/repos/actions/runner/releases/latest" | jq -r '.tag_name' | sed 's/^v//')
        mkdir -p "$runner_dir"
        local tarball="actions-runner-${runner_arch}-${latest}.tar.gz"
        curl -sL -o "/tmp/${tarball}" \
            "https://github.com/actions/runner/releases/download/v${latest}/${tarball}"
        tar xzf "/tmp/${tarball}" -C "$runner_dir"
        rm -f "/tmp/${tarball}"
        success "GitHub Actions Runner ${latest} 다운로드 완료"
    fi

    mark_done "phase1"
    echo ""
    success "Phase 1 완료: 모든 도구 준비됨"
}

# ============================================================================
# PHASE 2: User Input (로그인, 인증, 환경변수 — 한번에 모두)
# ============================================================================
phase2_user_input() {
    header "Phase 2: Configuration"
    info "로그인, 인증, 환경변수를 설정합니다."
    info "이 단계가 끝나면 나머지는 전부 자동입니다."
    echo ""

    # ── 2.1 배포 환경 설정 ──
    echo -e "${BOLD}── 배포 환경 ──${NC}"

    if [ -z "${DEPLOY_ENV:-}" ]; then
        echo -en "  환경 이름 ${DIM}[dev]${NC}: "
        read -r input; DEPLOY_ENV="${input:-dev}"
    fi
    info "DEPLOY_ENV=${DEPLOY_ENV}"

    if [ -z "${DEPLOY_BRANCH:-}" ]; then
        echo -en "  배포 브랜치 ${DIM}[${DEPLOY_ENV}]${NC}: "
        read -r input; DEPLOY_BRANCH="${input:-${DEPLOY_ENV}}"
    fi
    info "DEPLOY_BRANCH=${DEPLOY_BRANCH}"

    DEPLOY_DIR="/opt/soma-work/${DEPLOY_ENV}"
    info "DEPLOY_DIR=${DEPLOY_DIR}"

    if [ -z "${REPO:-}" ]; then
        echo -en "  GitHub 레포 ${DIM}[2lab-ai/soma-work]${NC}: "
        read -r input; REPO="${input:-2lab-ai/soma-work}"
    fi

    if [ -z "${BASE_DIRECTORY:-}" ]; then
        echo -en "  유저 작업 디렉토리 기준 ${DIM}[/tmp]${NC}: "
        read -r input; BASE_DIRECTORY="${input:-/tmp}"
    fi
    echo ""

    # ── 2.2 Slack 봇 설정 ──
    echo -e "${BOLD}── Slack 봇 설정 ──${NC}"

    if [ -z "${SLACK_APP_NAME:-}" ]; then
        echo -en "  Slack 앱 이름 ${DIM}[Claude Code Bot]${NC}: "
        read -r input; SLACK_APP_NAME="${input:-Claude Code Bot}"
    fi
    info "SLACK_APP_NAME=${SLACK_APP_NAME}"
    echo -e "  ${DIM}→ @handle은 Slack이 자동 생성${NC}"

    if [ -z "${BOT_DISPLAY_NAME:-}" ]; then
        echo -en "  봇 표시 이름 ${DIM}[Claude Code]${NC}: "
        read -r input; BOT_DISPLAY_NAME="${input:-Claude Code}"
    fi
    info "BOT_DISPLAY_NAME=${BOT_DISPLAY_NAME}"

    if [ -z "${BOT_ICON_PATH:-}" ]; then
        echo -en "  봇 아이콘 경로 ${DIM}[~/bot.png]${NC}: "
        read -r input; BOT_ICON_PATH="${input:-~/bot.png}"
    fi
    local icon_expanded
    icon_expanded="$(eval echo "${BOT_ICON_PATH}")"
    if [ -f "$icon_expanded" ]; then
        success "봇 아이콘 확인됨: ${icon_expanded}"
    else
        warn "봇 아이콘 파일 없음: ${icon_expanded} (나중에 수동 업로드 필요)"
    fi
    echo ""

    # ── 2.3 GitHub CLI 인증 ──
    echo -e "${BOLD}── GitHub 인증 ──${NC}"
    if gh auth status &>/dev/null; then
        success "GitHub CLI 인증됨: $(gh auth status 2>&1 | grep 'Logged in' | head -1)"
    else
        info "GitHub CLI 로그인이 필요합니다."
        gh auth login
        if gh auth status &>/dev/null; then
            success "GitHub CLI 인증 완료"
        else
            fail "GitHub CLI 인증 실패"
            exit 1
        fi
    fi

    # 레포 접근 확인
    if gh repo view "${REPO}" --json name -q '.name' &>/dev/null; then
        success "레포 접근 확인: ${REPO}"
    else
        fail "레포 접근 실패: ${REPO}"
        exit 1
    fi
    echo ""

    # ── 2.4 Slack CLI 인증 ──
    echo -e "${BOLD}── Slack 인증 ──${NC}"
    if slack auth list 2>/dev/null | grep -q "User ID"; then
        success "Slack CLI 인증됨: $(slack auth list 2>/dev/null | grep 'Team' | head -1)"
    else
        info "Slack CLI 로그인이 필요합니다."
        slack login
        if slack auth list 2>/dev/null | grep -q "User ID"; then
            success "Slack CLI 인증 완료"
        else
            fail "Slack CLI 인증 실패"
            exit 1
        fi
    fi
    echo ""

    # ── 2.5 Slack 토큰 (기존에 있으면 사용, 없으면 나중에 slack run으로 생성) ──
    echo -e "${BOLD}── Slack 토큰 ──${NC}"
    if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ] && [ -n "${SLACK_SIGNING_SECRET:-}" ]; then
        success "Slack 토큰 3개 환경변수로 제공됨"
        SLACK_TOKENS_PROVIDED=true
    else
        info "Slack 토큰이 없습니다."
        echo -e "  ${DIM}Phase 3에서 Slack CLI로 앱을 생성한 후,${NC}"
        echo -e "  ${DIM}앱 설정 페이지에서 토큰을 확인하여 입력합니다.${NC}"
        echo ""

        echo -e "  이미 생성된 Slack 앱의 토큰을 가지고 있나요?"
        echo -en "  (토큰이 있으면 y, 없으면 n — 나중에 생성) ${DIM}[n]${NC}: "
        read -r has_tokens
        if [[ "${has_tokens}" =~ ^[Yy] ]]; then
            echo -en "  SLACK_BOT_TOKEN (xoxb-...): "
            read -r SLACK_BOT_TOKEN
            echo -en "  SLACK_APP_TOKEN (xapp-...): "
            read -r SLACK_APP_TOKEN
            echo -en "  SLACK_SIGNING_SECRET: "
            read -r SLACK_SIGNING_SECRET
            SLACK_TOKENS_PROVIDED=true
            success "토큰 입력 완료"
        else
            SLACK_TOKENS_PROVIDED=false
            info "Phase 3에서 앱 생성 후 토큰을 수집합니다."
        fi
    fi
    echo ""

    # ── 2.6 선택: GitHub, Anthropic 설정 ──
    echo -e "${BOLD}── 추가 설정 (선택) ──${NC}"

    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        echo -en "  ANTHROPIC_API_KEY ${DIM}[Enter로 건너뛰기]${NC}: "
        read -r input; ANTHROPIC_API_KEY="${input:-}"
    fi
    [ -n "${ANTHROPIC_API_KEY}" ] && info "ANTHROPIC_API_KEY 설정됨" || info "ANTHROPIC_API_KEY 없음 (Claude 구독 사용)"

    if [ -z "${GITHUB_TOKEN:-}" ]; then
        echo -en "  GITHUB_TOKEN ${DIM}[Enter로 건너뛰기]${NC}: "
        read -r input; GITHUB_TOKEN="${input:-}"
    fi
    [ -n "${GITHUB_TOKEN}" ] && info "GITHUB_TOKEN 설정됨" || info "GITHUB_TOKEN 없음"

    echo ""

    # ── Save state ──
    set_state "deploy_env" "$DEPLOY_ENV"
    set_state "deploy_branch" "$DEPLOY_BRANCH"
    set_state "deploy_dir" "$DEPLOY_DIR"
    set_state "repo" "$REPO"
    set_state "base_directory" "$BASE_DIRECTORY"
    set_state "slack_app_name" "$SLACK_APP_NAME"
    set_state "bot_display_name" "$BOT_DISPLAY_NAME"
    set_state "bot_icon_path" "$BOT_ICON_PATH"
    set_state "slack_tokens_provided" "$SLACK_TOKENS_PROVIDED"

    mark_done "phase2"
    success "Phase 2 완료: 모든 설정 수집됨"
    echo ""
    echo -e "${BOLD}────────────────────────────────────────${NC}"
    echo -e "${BOLD}  이제부터 자동 설치가 시작됩니다.${NC}"
    echo -e "${BOLD}  유저 입력 없이 완료됩니다.${NC}"
    echo -e "${BOLD}────────────────────────────────────────${NC}"
    echo ""
    sleep 2
}

# ============================================================================
# PHASE 3: Unattended Setup (유저 입력 없이 끝까지)
# ============================================================================
phase3_unattended() {
    header "Phase 3: Unattended Setup"

    # Restore state
    DEPLOY_ENV="$(get_state deploy_env "${DEPLOY_ENV:-dev}")"
    DEPLOY_BRANCH="$(get_state deploy_branch "${DEPLOY_BRANCH:-dev}")"
    DEPLOY_DIR="$(get_state deploy_dir "/opt/soma-work/${DEPLOY_ENV}")"
    REPO="$(get_state repo "${REPO:-2lab-ai/soma-work}")"
    BASE_DIRECTORY="$(get_state base_directory "${BASE_DIRECTORY:-/tmp}")"
    SLACK_APP_NAME="$(get_state slack_app_name "${SLACK_APP_NAME:-Claude Code Bot}")"
    BOT_DISPLAY_NAME="$(get_state bot_display_name "${BOT_DISPLAY_NAME:-Claude Code}")"
    BOT_ICON_PATH="$(get_state bot_icon_path "${BOT_ICON_PATH:-~/bot.png}")"
    SLACK_TOKENS_PROVIDED="$(get_state slack_tokens_provided "${SLACK_TOKENS_PROVIDED:-false}")"

    local total=9
    local step=0

    # ── 3.1 배포 디렉토리 준비 ──
    step=$((step + 1))
    info "[${step}/${total}] 배포 디렉토리 준비..."

    if [ ! -d /opt/soma-work ]; then
        sudo mkdir -p /opt/soma-work
        sudo chown "$(whoami):staff" /opt/soma-work
    fi
    mkdir -p "${DEPLOY_DIR}"/{logs,data}

    if [ ! -d "${DEPLOY_DIR}/.git" ]; then
        info "  소스 클론 중..."
        git clone "https://github.com/${REPO}.git" "${DEPLOY_DIR}"
    fi

    cd "${DEPLOY_DIR}"
    git fetch origin
    git checkout "${DEPLOY_BRANCH}" 2>/dev/null || git checkout -b "${DEPLOY_BRANCH}" "origin/${DEPLOY_BRANCH}" 2>/dev/null || true

    info "  npm ci..."
    npm ci --silent 2>/dev/null
    info "  npm run build..."
    npm run build --silent 2>/dev/null
    success "  배포 디렉토리 준비 완료: ${DEPLOY_DIR}"

    # ── 3.2 Slack CLI 프로젝트 초기화 + manifest ──
    step=$((step + 1))
    info "[${step}/${total}] Slack 앱 설정..."

    cd "${DEPLOY_DIR}"

    # @slack/cli-hooks 설치 (바이너리 존재 확인)
    if [ ! -x "${DEPLOY_DIR}/node_modules/.bin/slack-cli-get-hooks" ]; then
        info "  @slack/cli-hooks 설치 중..."
        npm install --save-dev @slack/cli-hooks 2>/dev/null
        success "  @slack/cli-hooks 설치됨"
    else
        success "  @slack/cli-hooks 이미 존재"
    fi

    # npx 절대 경로 탐색 (Slack CLI가 PATH를 못 찾는 문제 해결)
    local npx_path
    npx_path="$(command -v npx)"
    if [ -z "$npx_path" ]; then
        fail "  npx를 찾을 수 없습니다"
        exit 1
    fi
    success "  npx 경로: ${npx_path}"

    # manifest.json 생성
    cat > "${DEPLOY_DIR}/manifest.json" << MANIFEST_EOF
{
    "display_information": {
        "name": "${SLACK_APP_NAME}",
        "description": "AI-powered coding assistant using Claude Code SDK",
        "background_color": "#4A154B"
    },
    "features": {
        "app_home": {
            "home_tab_enabled": false,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": false
        },
        "bot_user": {
            "display_name": "${BOT_DISPLAY_NAME}",
            "always_online": true
        }
    },
    "oauth_config": {
        "scopes": {
            "bot": [
                "assistant:write",
                "app_mentions:read",
                "channels:history",
                "chat:write",
                "chat:write.public",
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
                "message.im",
                "member_joined_channel"
            ]
        },
        "interactivity": { "is_enabled": false },
        "org_deploy_enabled": false,
        "socket_mode_enabled": true,
        "token_rotation_enabled": false
    }
}
MANIFEST_EOF
    success "  manifest.json 생성됨 (앱: ${SLACK_APP_NAME}, 봇: ${BOT_DISPLAY_NAME})"

    # .slack/ 디렉토리 수동 생성 (slack init은 interactive prompt가 있어서 사용 안 함)
    if [ ! -d "${DEPLOY_DIR}/.slack" ]; then
        mkdir -p "${DEPLOY_DIR}/.slack"

        # .slack/.gitignore
        cat > "${DEPLOY_DIR}/.slack/.gitignore" << 'SLACKGIT_EOF'
apps.json
apps.dev.json
SLACKGIT_EOF

        # .slack/config.json — manifest source를 local로 설정
        cat > "${DEPLOY_DIR}/.slack/config.json" << 'SLACKCFG_EOF'
{
  "manifest-source": "local"
}
SLACKCFG_EOF

        success "  .slack/ 디렉토리 생성됨"
    else
        success "  .slack/ 이미 존재"
    fi

    # .slack/hooks.json — 절대 경로로 npx 지정 (Slack CLI PATH 문제 해결)
    cat > "${DEPLOY_DIR}/.slack/hooks.json" << HOOKS_EOF
{
  "hooks": {
    "get-hooks": "${npx_path} -q --no-install -p @slack/cli-hooks slack-cli-get-hooks",
    "get-manifest": "${npx_path} -q --no-install -p @slack/cli-hooks slack-cli-get-manifest",
    "start": "${npx_path} -q --no-install -p @slack/cli-hooks slack-cli-start",
    "check-update": "${npx_path} -q --no-install -p @slack/cli-hooks slack-cli-check-update",
    "doctor": "${npx_path} -q --no-install -p @slack/cli-hooks slack-cli-doctor"
  },
  "config": {
    "watch": {
      "manifest": { "paths": ["manifest.json"] },
      "app": { "paths": ["."], "filter-regex": "\\\\.(js|ts)$" }
    },
    "protocol-version": ["message-boundaries"],
    "sdk-managed-connection-enabled": true
  }
}
HOOKS_EOF
    success "  hooks.json 생성됨 (npx: ${npx_path})"

    # Slack 앱 생성 (slack run으로 앱 생성 → start 실패해도 앱은 생성됨)
    if [ ! -f "${DEPLOY_DIR}/.slack/apps.dev.json" ]; then
        echo ""
        info "  Slack 앱을 생성합니다."
        info "  'slack run'이 앱 생성 후 시작을 시도합니다."
        info "  앱이 생성되면 Ctrl+C로 중단하세요."
        echo ""
        slack run || true
        echo ""
        if [ -f "${DEPLOY_DIR}/.slack/apps.dev.json" ]; then
            success "  Slack 앱 생성됨: $(cat "${DEPLOY_DIR}/.slack/apps.dev.json")"
        else
            warn "  Slack 앱이 생성되지 않았습니다."
            info "  수동으로 'cd ${DEPLOY_DIR} && slack run' 실행하세요."
        fi
    else
        success "  Slack 앱 이미 존재: $(cat "${DEPLOY_DIR}/.slack/apps.dev.json")"
    fi

    # ── 3.3 설정 파일 생성 ──
    step=$((step + 1))
    info "[${step}/${total}] 설정 파일 생성..."

    # .env
    if [ ! -f "${DEPLOY_DIR}/.env" ]; then
        cat > "${DEPLOY_DIR}/.env" << ENV_EOF
# === Slack (필수) ===
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-xoxb-PASTE-HERE}
SLACK_APP_TOKEN=${SLACK_APP_TOKEN:-xapp-PASTE-HERE}
SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET:-PASTE-HERE}

# === 작업 디렉토리 (필수) ===
BASE_DIRECTORY=${BASE_DIRECTORY}

# === Claude Code (선택) ===
${ANTHROPIC_API_KEY:+ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}}
${ANTHROPIC_API_KEY:-# ANTHROPIC_API_KEY=sk-ant-...}

# === GitHub Token (선택) ===
${GITHUB_TOKEN:+GITHUB_TOKEN=${GITHUB_TOKEN}}
${GITHUB_TOKEN:-# GITHUB_TOKEN=ghp_...}

# === 기타 (선택) ===
# DEBUG=true
# DISPATCH_MODEL=claude-haiku-4-5-20251001
# DEFAULT_UPDATE_CHANNEL=#ai
ENV_EOF
        chmod 600 "${DEPLOY_DIR}/.env"
        success "  .env 생성됨"
    else
        success "  .env 이미 존재 (보존)"
    fi

    # .system.prompt
    if [ ! -f "${DEPLOY_DIR}/.system.prompt" ]; then
        cat > "${DEPLOY_DIR}/.system.prompt" << 'PROMPT_EOF'
# Facts
## Repository
- https://github.com/2lab-ai/soma/
- https://github.com/2lab-ai/soma-work/
  - PR target: main
PROMPT_EOF
        success "  .system.prompt 생성됨"
    else
        success "  .system.prompt 이미 존재 (보존)"
    fi

    # mcp-servers.json
    if [ ! -f "${DEPLOY_DIR}/mcp-servers.json" ]; then
        cat > "${DEPLOY_DIR}/mcp-servers.json" << 'MCP_EOF'
{
  "mcpServers": {
    "jira": {
      "type": "sse",
      "url": "https://mcp.atlassian.com/v1/sse"
    }
  }
}
MCP_EOF
        success "  mcp-servers.json 생성됨"
    else
        success "  mcp-servers.json 이미 존재 (보존)"
    fi

    # config.json (soma-work용)
    if [ ! -f "${DEPLOY_DIR}/config.json" ]; then
        cat > "${DEPLOY_DIR}/config.json" << 'CONFIG_EOF'
{
  "mcpServers": {
    "jira": {
      "type": "sse",
      "url": "https://mcp.atlassian.com/v1/sse"
    }
  },
  "plugin": {
    "marketplace": [
      { "name": "soma-work", "repo": "2lab-ai/soma-work", "ref": "main" }
    ],
    "plugins": ["omc@soma-work"],
    "localOverrides": []
  }
}
CONFIG_EOF
        success "  config.json 생성됨"
    else
        success "  config.json 이미 존재 (보존)"
    fi

    # ── 3.4 GitHub Actions Runner 등록 ──
    step=$((step + 1))
    info "[${step}/${total}] GitHub Actions Runner 등록..."

    local runner_dir="$HOME/actions-runner"
    if [ -f "${runner_dir}/.runner" ]; then
        # Runner가 이미 등록됨 — 서비스 확인만
        success "  Runner 이미 등록됨"
        if ! "${runner_dir}/svc.sh" status &>/dev/null 2>&1; then
            "${runner_dir}/svc.sh" install 2>/dev/null || true
            "${runner_dir}/svc.sh" start 2>/dev/null || true
        fi
    else
        info "  Runner 등록 중..."
        local reg_token
        reg_token=$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq '.token')

        cd "$runner_dir"
        local runner_name
        runner_name="$(hostname -s)"
        ./config.sh \
            --url "https://github.com/${REPO}" \
            --token "$reg_token" \
            --name "${runner_name}" \
            --labels "self-hosted,macOS,$(uname -m),${runner_name}" \
            --unattended \
            --replace

        ./svc.sh install 2>/dev/null || true
        ./svc.sh start 2>/dev/null || true
        success "  Runner 등록 완료: ${runner_name} (labels: self-hosted,macOS,$(uname -m),${runner_name})"
    fi
    cd "${DEPLOY_DIR}"

    # ── 3.5 GitHub Environment 설정 ──
    step=$((step + 1))
    info "[${step}/${total}] GitHub Environment 설정..."

    local env_name
    case "${DEPLOY_ENV}" in
        main) env_name="production" ;;
        dev)  env_name="development" ;;
        *)    env_name="${DEPLOY_ENV}" ;;
    esac

    gh api -X PUT "repos/${REPO}/environments/${env_name}" \
        --input - << JSON 2>/dev/null || true
{
    "deployment_branch_policy": {
        "protected_branches": false,
        "custom_branch_policies": true
    }
}
JSON

    gh api -X POST "repos/${REPO}/environments/${env_name}/deployment-branch-policies" \
        --field name="${DEPLOY_BRANCH}" \
        --field type="branch" 2>/dev/null || true
    success "  Environment '${env_name}' (branch: ${DEPLOY_BRANCH})"

    # ── 3.6 LaunchAgent 서비스 설치 ──
    step=$((step + 1))
    info "[${step}/${total}] LaunchAgent 서비스 설치..."

    local service_sh="${DEPLOY_DIR}/service.sh"
    if [ -f "$service_sh" ]; then
        # service.sh가 인식하는 환경인지 확인
        if [[ "$DEPLOY_ENV" == "main" || "$DEPLOY_ENV" == "dev" ]]; then
            bash "$service_sh" "${DEPLOY_ENV}" install 2>/dev/null || true
            success "  서비스 설치됨: ai.2lab.soma-work.${DEPLOY_ENV}"
        else
            # 커스텀 환경 — 현재 디렉토리 모드
            cd "${DEPLOY_DIR}"
            bash "$service_sh" install 2>/dev/null || true
            success "  서비스 설치됨 (현재 디렉토리 모드)"
        fi
    else
        warn "  service.sh 없음 — 수동 서비스 설정 필요"
    fi

    # ── 3.7 Slack 앱 토큰 수집 (토큰이 없는 경우) ──
    step=$((step + 1))
    info "[${step}/${total}] Slack 토큰 확인..."

    if [ "$SLACK_TOKENS_PROVIDED" = "true" ]; then
        success "  토큰이 이미 .env에 기록됨"
    else
        echo ""
        echo -e "${YELLOW}╔══════════════════════════════════════════════════════╗${NC}"
        echo -e "${YELLOW}║  Slack 앱 토큰 수집이 필요합니다 (1회성 수동 작업)  ║${NC}"
        echo -e "${YELLOW}╚══════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo "  앱 설정 페이지를 열고 있습니다..."
        slack app settings 2>/dev/null || true
        echo ""
        echo "  브라우저에서 다음 토큰을 확인하세요:"
        echo "    1. Bot Token:      OAuth & Permissions → Bot User OAuth Token (xoxb-...)"
        echo "    2. App Token:      Basic Information → App-Level Tokens → Generate"
        echo "                       (Token Name: socket-mode, Scope: connections:write)"
        echo "    3. Signing Secret: Basic Information → App Credentials"
        echo ""

        echo -en "  SLACK_BOT_TOKEN (xoxb-...): "
        read -r SLACK_BOT_TOKEN
        echo -en "  SLACK_APP_TOKEN (xapp-...): "
        read -r SLACK_APP_TOKEN
        echo -en "  SLACK_SIGNING_SECRET: "
        read -r SLACK_SIGNING_SECRET

        # .env 업데이트
        if [ -n "$SLACK_BOT_TOKEN" ]; then
            sed -i '' "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}|" "${DEPLOY_DIR}/.env"
        fi
        if [ -n "$SLACK_APP_TOKEN" ]; then
            sed -i '' "s|^SLACK_APP_TOKEN=.*|SLACK_APP_TOKEN=${SLACK_APP_TOKEN}|" "${DEPLOY_DIR}/.env"
        fi
        if [ -n "$SLACK_SIGNING_SECRET" ]; then
            sed -i '' "s|^SLACK_SIGNING_SECRET=.*|SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET}|" "${DEPLOY_DIR}/.env"
        fi
        success "  .env에 토큰 저장됨"
    fi

    # ── 3.8 봇 프로필 이미지 안내 ──
    step=$((step + 1))
    info "[${step}/${total}] 봇 프로필 이미지..."

    local icon_expanded
    icon_expanded="$(eval echo "${BOT_ICON_PATH}")"
    if [ -f "$icon_expanded" ]; then
        echo ""
        echo -e "${YELLOW}╔══════════════════════════════════════════════════════╗${NC}"
        echo -e "${YELLOW}║  봇 아이콘 업로드 (1회성 수동 작업)                 ║${NC}"
        echo -e "${YELLOW}╚══════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo "  앱 설정 페이지의 'Display Information → App Icon'에서"
        echo "  아래 파일을 업로드하세요:"
        echo "    ${icon_expanded}"
        echo ""
        # macOS: Finder에서 파일 위치 표시
        open -R "$icon_expanded" 2>/dev/null || true
        echo -e "  ${DIM}(Finder에서 파일이 선택되었습니다. 드래그&드롭하세요.)${NC}"
        echo ""
        echo -en "  업로드 완료했으면 Enter... "
        read -r
        success "  봇 아이콘 설정 완료"
    else
        warn "  봇 아이콘 파일 없음: ${icon_expanded}"
        info "  나중에 앱 설정 → Display Information → App Icon에서 업로드하세요."
    fi

    # ── 3.9 서비스 재시작 + 검증 ──
    step=$((step + 1))
    info "[${step}/${total}] 서비스 시작 + 검증..."

    if [ -f "$service_sh" ]; then
        if [[ "$DEPLOY_ENV" == "main" || "$DEPLOY_ENV" == "dev" ]]; then
            bash "$service_sh" "${DEPLOY_ENV}" restart 2>/dev/null || true
            sleep 3
            bash "$service_sh" "${DEPLOY_ENV}" status
        else
            cd "${DEPLOY_DIR}"
            bash "$service_sh" restart 2>/dev/null || true
            sleep 3
            bash "$service_sh" status
        fi
    fi

    echo ""
    info "Slack 연결 확인 중..."
    sleep 5
    if grep -qi "connected\|socket.*open\|ready" "${DEPLOY_DIR}/logs/stderr.log" 2>/dev/null; then
        success "Slack 연결 확인됨!"
    else
        warn "Slack 연결 로그를 찾지 못했습니다."
        info "로그 확인: tail -f ${DEPLOY_DIR}/logs/stderr.log"
    fi

    mark_done "phase3"
}

# ============================================================================
# SUMMARY
# ============================================================================
print_summary() {
    DEPLOY_ENV="$(get_state deploy_env "${DEPLOY_ENV:-dev}")"
    DEPLOY_DIR="$(get_state deploy_dir "/opt/soma-work/${DEPLOY_ENV}")"
    SLACK_APP_NAME="$(get_state slack_app_name "${SLACK_APP_NAME:-Claude Code Bot}")"
    BOT_DISPLAY_NAME="$(get_state bot_display_name "${BOT_DISPLAY_NAME:-Claude Code}")"

    header "Setup Complete!"

    echo -e "  ${BOLD}Environment:${NC}  ${DEPLOY_ENV}"
    echo -e "  ${BOLD}Directory:${NC}    ${DEPLOY_DIR}"
    echo -e "  ${BOLD}Slack App:${NC}    ${SLACK_APP_NAME}"
    echo -e "  ${BOLD}Bot Name:${NC}     ${BOT_DISPLAY_NAME}"
    echo ""
    echo -e "  ${BOLD}유용한 명령어:${NC}"
    echo -e "    ${CYAN}./service.sh ${DEPLOY_ENV} status${NC}      서비스 상태"
    echo -e "    ${CYAN}./service.sh ${DEPLOY_ENV} logs follow${NC} 실시간 로그"
    echo -e "    ${CYAN}./service.sh ${DEPLOY_ENV} restart${NC}     재시작"
    echo ""
    echo -e "  ${BOLD}다음 단계:${NC}"
    echo -e "    1. Slack에서 봇에게 DM: \"안녕\""
    echo -e "    2. 봇을 채널에 초대: /invite @${BOT_DISPLAY_NAME}"
    echo -e "    3. git push origin ${DEPLOY_ENV} → 자동 배포 시작"
    echo ""

    # Cleanup state file
    info "State file: ${STATE_FILE}"
    info "(재실행 시 완료된 단계는 건너뜁니다)"
}

# ============================================================================
# MAIN
# ============================================================================
main() {
    echo -e "${BOLD}"
    echo "  ┌─────────────────────────────────────┐"
    echo "  │   soma-work: New Node Deploy Setup   │"
    echo "  └─────────────────────────────────────┘"
    echo -e "${NC}"

    # Phase 1: Prerequisites (idempotent)
    if ! is_done "phase1"; then
        phase1_prerequisites
    else
        success "Phase 1: Prerequisites (이미 완료, 건너뜀)"
    fi

    # Phase 2: User Input
    if ! is_done "phase2"; then
        phase2_user_input
    else
        success "Phase 2: Configuration (이미 완료, 건너뜀)"
    fi

    # Phase 3: Unattended
    if ! is_done "phase3"; then
        phase3_unattended
    else
        success "Phase 3: Unattended Setup (이미 완료, 건너뜀)"
    fi

    print_summary
}

main "$@"
