# 신규 노드 배포 가이드

> **목표**: 새로운 macOS 서버에 soma-work를 배포하는 전체 과정.
> AI 에이전트가 이 문서를 읽고 대부분의 단계를 자동으로 실행할 수 있도록 구성.

## 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [사전 준비 (수동)](#2-사전-준비-수동)
3. [SSH 접속 설정](#3-ssh-접속-설정)
4. [서버 환경 준비](#4-서버-환경-준비)
5. [GitHub Self-Hosted Runner 등록](#5-github-self-hosted-runner-등록)
6. [배포 디렉토리 준비](#6-배포-디렉토리-준비)
7. [Slack 앱 생성](#7-slack-앱-생성)
8. [설정 파일 작성](#8-설정-파일-작성)
9. [GitHub Environments 설정](#9-github-environments-설정)
10. [첫 배포 트리거](#10-첫-배포-트리거)
11. [서비스 검증](#11-서비스-검증)
12. [Slack 채널 설정](#12-slack-채널-설정)
13. [트러블슈팅](#13-트러블슈팅)

---

## 1. 아키텍처 개요

```
┌─────────────┐     git push      ┌──────────────────┐
│  Developer   │ ──────────────▶  │  GitHub Actions   │
└─────────────┘                   │  (CI: lint+test)  │
                                  └────────┬─────────┘
                                           │ trigger
                                  ┌────────▼─────────┐
                                  │  Self-Hosted       │
                                  │  Runner (on Node)  │
                                  │  deploy.yml        │
                                  └────────┬─────────┘
                                           │ rsync
                        ┌──────────────────┼──────────────────┐
                        ▼                  ▼                  ▼
               /opt/soma-work/main  /opt/soma-work/dev   /opt/soma-work/<custom>
               (deploy/prod 브랜치) (main 브랜치)         (추가 브랜치)
                        │                  │                  │
                        ▼                  ▼                  ▼
               LaunchAgent           LaunchAgent          LaunchAgent
               (auto-restart)        (auto-restart)       (auto-restart)
                        │                  │                  │
                        ▼                  ▼                  ▼
               Slack App A           Slack App B          Slack App C
               (Socket Mode)        (Socket Mode)        (Socket Mode)
```

**핵심 원칙**:
- 배포 소스 브랜치 1개 = 배포 환경 1개 = Slack 앱 1개 = 전용 채널 1개
- 같은 Slack 토큰으로 2개 인스턴스 절대 금지 (메시지 중복/충돌)
- 설정 파일(.env 등)은 배포 시 보존됨 (rsync exclude)

> **macmini main bootstrap**: 첫 `deploy/prod` 배포는 self-hosted runner가 `/opt/soma-work/dev`의 설정 구조를 seed로 복사하고, legacy 운영 경로 `/Users/dd/app.claude-code-slack-bot/.env` 및 `/Users/dd/app.claude-code-slack-bot/data`를 `/opt/soma-work/main`으로 가져온 뒤 `.main-bootstrap.json` marker를 남긴다. marker가 생긴 뒤에는 이후 `deploy/prod` 배포가 코드만 갱신한다.

---

## 2. 사전 준비 (수동)

아래 항목은 자동화 불가. 사람이 직접 준비해야 함.

### 2.1 필요 계정/권한

| 항목 | 설명 |
|------|------|
| macOS 서버 | SSH 접속 가능한 물리/가상 macOS 머신 |
| GitHub 계정 | 레포 `2lab-ai/soma-work`에 admin 또는 write 접근 |
| Slack 워크스페이스 | 앱을 설치할 워크스페이스의 admin 권한 |
| Anthropic API | Claude Code 구독 또는 `ANTHROPIC_API_KEY` |

### 2.2 결정 사항

배포 전에 아래 값을 확정:

```bash
# ── 필수 결정 사항 ──
DEPLOY_ENV="staging"              # 환경 이름 (main, dev, staging, ...)
DEPLOY_BRANCH="staging"           # 배포할 git 브랜치
DEPLOY_DIR="/opt/soma-work/${DEPLOY_ENV}"
REPO="2lab-ai/soma-work"                # GitHub 레포
BASE_DIRECTORY="/tmp"                    # 유저 작업 디렉토리 기준 경로

# ── Slack 앱 설정 ──
SLACK_APP_NAME="Claude Code (Staging)"  # Slack 앱 이름 (35자 이내)
BOT_DISPLAY_NAME="Claude Code"          # 봇 표시 이름 (80자 이내, a-z 0-9 - _ .)
BOT_ICON_PATH="~/bot.png"              # 봇 프로필 이미지 (512x512 이상, PNG/JPEG)
SLACK_CHANNEL="#workspace-staging"       # 전용 Slack 채널
```

> **봇 @handle 참고**: Slack이 `SLACK_APP_NAME`에서 자동 생성한다.
> 예: "Claude Code (Staging)" → `@claudecodestaging`
> @handle을 직접 지정할 수 없음 (Slack 제약).
>
> **봇 아이콘 참고**: Slack API에 앱 아이콘 업로드 엔드포인트가 없다.
> 앱 생성 후 스크립트가 **설정 페이지를 자동으로 열어주므로** 거기서 업로드.
> `BOT_ICON_PATH`는 업로드 안내용으로 사용.

---

## 3. SSH 접속 설정

### 3.1 로컬 머신에서 SSH 키 설정

```bash
# 키가 없으면 생성
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -C "deploy@soma-work"

# 공개키 확인
cat ~/.ssh/id_ed25519.pub
```

### 3.2 서버에 SSH 키 등록

```bash
# 서버 주소와 유저를 환경에 맞게 변경
SERVER_USER="deploy"
SERVER_HOST="192.168.1.100"

# 공개키 전송
ssh-copy-id ${SERVER_USER}@${SERVER_HOST}

# 접속 테스트
ssh ${SERVER_USER}@${SERVER_HOST} "echo 'SSH OK: $(hostname)'"
```

### 3.3 SSH config 등록 (선택)

```bash
cat >> ~/.ssh/config << 'EOF'
Host soma-staging
    HostName 192.168.1.100
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    ForwardAgent yes
EOF

# 이후 ssh soma-staging 으로 접속 가능
```

---

## 4. 서버 환경 준비

> 이하 모든 명령은 **서버에 SSH 접속 후** 실행.

### 4.1 필수 도구 설치

```bash
# Homebrew (없는 경우)
command -v brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 필수 도구
brew install node git gh curl jq

# 버전 확인
node --version   # v20+ 권장
git --version
gh --version
jq --version
```

### 4.2 GitHub CLI 인증

```bash
gh auth login
# → GitHub.com, HTTPS, Authenticate with a web browser
# → 브라우저에서 인증 완료

# 레포 접근 확인
gh repo view ${REPO} --json name -q '.name'
```

### 4.3 Claude Code 설치 (선택 - 에이전트용)

```bash
# Claude Code SDK가 필요한 경우
npm install -g @anthropic-ai/claude-code
```

---

## 5. GitHub Self-Hosted Runner 등록

### 5.1 자동 설치 스크립트

```bash
#!/bin/bash
# === GitHub Self-Hosted Runner 자동 설치 ===
set -euo pipefail

REPO="${REPO:-2lab-ai/soma-work}"
RUNNER_DIR="$HOME/actions-runner"
RUNNER_NAME="$(hostname -s)-$(date +%s)"

# 아키텍처 감지
ARCH=$(uname -m)
case "$ARCH" in
    arm64)  RUNNER_ARCH="osx-arm64" ;;
    x86_64) RUNNER_ARCH="osx-x64" ;;
    *)      echo "Unsupported: $ARCH"; exit 1 ;;
esac

# 최신 버전 조회
LATEST=$(gh api repos/actions/runner/releases/latest --jq '.tag_name' | sed 's/^v//')
echo "Runner version: $LATEST ($RUNNER_ARCH)"

# 다운로드 및 설치
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

if [ ! -f config.sh ]; then
    TARBALL="actions-runner-${RUNNER_ARCH}-${LATEST}.tar.gz"
    curl -sL -o "$TARBALL" \
      "https://github.com/actions/runner/releases/download/v${LATEST}/${TARBALL}"
    tar xzf "$TARBALL"
    rm -f "$TARBALL"
fi

# Registration token 발급
REG_TOKEN=$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq '.token')

# 등록 (비대화형)
./config.sh \
    --url "https://github.com/${REPO}" \
    --token "$REG_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "self-hosted,macOS,ARM64,soma-work" \
    --unattended \
    --replace

# LaunchAgent로 등록 (자동 시작)
./svc.sh install
./svc.sh start

# 상태 확인
sleep 3
RUNNER_STATUS=$(gh api "repos/${REPO}/actions/runners" \
    --jq ".runners[] | select(.name==\"${RUNNER_NAME}\") | .status")
echo "Runner status: ${RUNNER_STATUS:-unknown}"
```

### 5.2 Runner 확인

```bash
# GitHub에서 러너 목록 조회
gh api "repos/${REPO}/actions/runners" --jq '.runners[] | "\(.name): \(.status)"'
```

### 5.3 다중 Runner 주의

하나의 레포에 여러 Runner가 등록되면 GitHub가 임의로 Runner를 선택한다.
특정 노드에서만 배포하려면 **deploy.yml의 `runs-on` 레이블**을 지정:

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on: [self-hosted, soma-staging]  # 특정 레이블만 매칭
```

---

## 6. 배포 디렉토리 준비

### 6.1 디렉토리 생성

```bash
DEPLOY_ENV="${DEPLOY_ENV:-dev}"
DEPLOY_DIR="/opt/soma-work/${DEPLOY_ENV}"

# 디렉토리 생성 (첫 1회만 sudo 필요)
sudo mkdir -p /opt/soma-work
sudo chown "$(whoami):staff" /opt/soma-work

mkdir -p "${DEPLOY_DIR}"/{logs,data}
```

### 6.2 소스 코드 초기 배포

CI가 첫 배포를 하기 전에 수동으로 초기 설정:

```bash
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

# 클론 (또는 service.sh setup 사용)
git clone "https://github.com/${REPO}.git" "${DEPLOY_DIR}"
cd "${DEPLOY_DIR}"
git checkout "${DEPLOY_BRANCH}" 2>/dev/null || git checkout -b "${DEPLOY_BRANCH}"

# 빌드
npm ci
npm run build

# 디렉토리 확인
ls -la "${DEPLOY_DIR}/"
```

> **참고**: 이후 CI가 자동으로 `rsync`로 `dist/`, `node_modules/`, `package.json`을 동기화함.

---

## 7. Slack 앱 생성

3가지 방법을 자동화 수준 순으로 제시. **방법 A (Slack CLI)를 권장**.

### 7.1 방법 A: Slack CLI (권장 - 최고 자동화)

Slack CLI v3.13+는 Bolt 앱을 직접 지원한다. `slack run`이 **앱 생성 + 워크스페이스 설치 + 토큰 자동 관리**를 한번에 처리.

> 참고: [Slack CLI Bolt Framework 가이드](https://docs.slack.dev/tools/slack-cli/guides/using-slack-cli-with-bolt-frameworks/)

#### Step 1: Slack CLI 설치 + 로그인

```bash
# Slack CLI 설치 (없는 경우)
curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash

# 워크스페이스 로그인
slack login
# → 브라우저에서 인증 (챌린지 코드 입력)

# 로그인 확인
slack auth list
```

**비대화형 로그인** (CI/서버 환경):

```bash
# 1단계: 티켓 발급 (서버)
TICKET_RESPONSE=$(slack auth login --no-prompt 2>&1)
TICKET=$(echo "$TICKET_RESPONSE" | grep -oE 'ISQ[A-Za-z0-9]+')
echo "Ticket: $TICKET"
# → 출력된 URL을 브라우저에서 열고, 챌린지 코드 확인

# 2단계: 챌린지 코드로 인증 완료 (서버)
slack auth login --ticket "$TICKET" --challenge "XXXXXXXX"
```

#### Step 2: 프로젝트 초기화

```bash
cd "${DEPLOY_DIR}"

# @slack/cli-hooks 설치 (Bolt ↔ Slack CLI 연동)
npm install --save-dev @slack/cli-hooks

# Slack CLI 프로젝트 초기화
slack init
# → Node.js 감지, .slack/ 디렉토리 생성
```

**`slack init`이 생성하는 파일:**

```
.slack/
├── .gitignore
├── apps.json          # 앱 ID ↔ 워크스페이스 매핑
├── apps.dev.json      # 개발용 앱 매핑
├── config.json        # manifest source 설정
└── hooks.json         # CLI 훅 설정 (get-hooks 등)
```

#### Step 3: manifest.json 준비

Slack CLI는 `manifest.json`(JSON 형식)을 사용한다.
**환경변수 `SLACK_APP_NAME`, `BOT_DISPLAY_NAME`**을 매니페스트에 반영:

```bash
# 환경변수 기본값 설정
SLACK_APP_NAME="${SLACK_APP_NAME:-Claude Code Bot}"
BOT_DISPLAY_NAME="${BOT_DISPLAY_NAME:-Claude Code}"

# manifest.json 생성 (환경변수 치환)
cat > "${DEPLOY_DIR}/manifest.json" << EOF
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
EOF
```

> **Tip**: `SLACK_APP_NAME`을 환경별로 다르게 설정하면 Slack에서 구별이 쉽다.
> 예: "Claude Code (Staging)", "Claude Code (Dev)"
> Slack이 이 이름에서 @handle을 자동 생성: `@claudecodestaging`, `@claudecodedev`

#### Step 4: 앱 생성 + 설치 (`slack run`)

```bash
slack run
# → 처음 실행 시:
#   1. manifest.json으로 앱 자동 생성
#   2. 워크스페이스에 자동 설치
#   3. Bot Token(xoxb), App Token(xapp) 자동 발급
#   4. 환경변수로 자동 주입:
#      SLACK_BOT_TOKEN, SLACK_APP_TOKEN
#      SLACK_CLI_XOXB, SLACK_CLI_XAPP
#   5. start hook으로 앱 실행
```

#### Step 4.5: 봇 프로필 이미지 설정

> Slack API에 앱 아이콘 업로드 엔드포인트가 없으므로 웹에서 수동 설정.
> 스크립트가 자동으로 설정 페이지를 열어준다.

```bash
BOT_ICON_PATH="${BOT_ICON_PATH:-~/bot.png}"

# 앱 설정 페이지 열기
slack app settings
# → 브라우저에서 앱 설정 페이지 열림

echo ""
echo "=== 봇 프로필 이미지 설정 ==="
echo "1. 브라우저에서 'Basic Information' 페이지 확인"
echo "2. 'Display Information' 섹션으로 스크롤"
echo "3. 'App Icon' 영역에 이미지 업로드: ${BOT_ICON_PATH}"
echo "   (권장: 512x512px 이상, PNG 또는 JPEG)"
echo "4. 'Save Changes' 클릭"
echo ""

# 이미지 파일 존재 확인
if [ -f "$(eval echo ${BOT_ICON_PATH})" ]; then
    echo "이미지 파일 확인됨: $(eval echo ${BOT_ICON_PATH})"
    echo "$(file "$(eval echo ${BOT_ICON_PATH})")"

    # macOS: Finder에서 이미지 파일 열기 (드래그 앤 드롭 편의)
    open -R "$(eval echo ${BOT_ICON_PATH})"
else
    echo "WARNING: ${BOT_ICON_PATH} 파일을 찾을 수 없습니다."
    echo "이미지를 준비한 후 앱 설정에서 업로드하세요."
fi
```

> `slack run`은 개발 모드. **프로덕션 배포**에는 토큰을 .env에 저장해야 한다.

#### Step 5: 프로덕션용 토큰 추출

`slack run`이 앱을 만든 후, 프로덕션용 토큰을 가져오는 방법:

**방법 A**: 앱 설정 페이지에서 직접 확인

```bash
# 앱 설정 페이지 열기
slack app settings
# → 브라우저에서 앱 설정 페이지 열림

# Bot Token: OAuth & Permissions → Bot User OAuth Token (xoxb-...)
# App Token: Basic Information → App-Level Tokens → Generate (scope: connections:write) (xapp-...)
# Signing Secret: Basic Information → App Credentials → Signing Secret
```

**방법 B**: `slack run` + 토큰 캡처 스크립트

```bash
# start hook이 받는 환경변수에서 토큰 추출
# .slack/hooks.json의 start 스크립트를 임시로 토큰 출력 스크립트로 교체

cat > /tmp/capture-tokens.sh << 'SCRIPT'
#!/bin/bash
echo "=== Slack Tokens (프로덕션용 .env에 복사) ==="
echo "SLACK_BOT_TOKEN=${SLACK_CLI_XOXB:-${SLACK_BOT_TOKEN}}"
echo "SLACK_APP_TOKEN=${SLACK_CLI_XAPP:-${SLACK_APP_TOKEN}}"
echo ""
echo "이 값들을 .env 파일에 복사하세요."
echo "Ctrl+C로 종료"
# 종료 안 하면 CLI가 재시작 시도
sleep 3600
SCRIPT
chmod +x /tmp/capture-tokens.sh

# hooks.json에서 start 명령을 임시 교체 후 slack run
# 또는 단순히 slack run 후 앱 설정 페이지에서 확인
```

**방법 C**: 서비스 토큰 발급 (CI/CD용)

```bash
# Slack CLI 서비스 토큰 (자동 인증)
slack auth token
# → 서비스 토큰 발급 (CI/CD 파이프라인에서 사용)
```

#### Step 6: .env에 토큰 저장

```bash
# 추출한 토큰을 .env에 기록
cat >> "${DEPLOY_DIR}/.env" << EOF
SLACK_BOT_TOKEN=xoxb-PASTE-HERE
SLACK_APP_TOKEN=xapp-PASTE-HERE
SLACK_SIGNING_SECRET=PASTE-HERE
EOF
```

#### Slack CLI 앱 관리 명령어 요약

```bash
slack auth list              # 인증된 워크스페이스 목록
slack app list               # 앱 설치된 팀 목록
slack app settings           # 앱 설정 페이지 열기 (브라우저)
slack app install            # 추가 워크스페이스에 설치
slack app uninstall          # 워크스페이스에서 제거
slack manifest info          # 현재 매니페스트 확인
slack manifest validate      # 매니페스트 유효성 검사
slack doctor                 # 환경 진단
```

---

### 7.2 방법 B: Slack Manifest API (스크립트 자동화)

Slack CLI를 사용할 수 없는 환경에서 `apps.manifest.create` API를 직접 호출.

#### 사전 조건: Configuration Token 발급

> **웹 UI 1회 필요**.

1. https://api.slack.com/apps 접속
2. 아무 기존 앱 선택 (또는 빈 앱 하나 생성)
3. 좌측 메뉴 **Your App Configuration Tokens** 클릭
4. **Generate Token** 클릭 → 워크스페이스 선택
5. `xoxe-...` 토큰 복사 (12시간 유효)

```bash
export SLACK_CONFIG_TOKEN="xoxe-1-..."
```

#### 앱 생성 스크립트

```bash
#!/bin/bash
# === Slack 앱 생성 (Manifest API) ===
set -euo pipefail

SLACK_CONFIG_TOKEN="${SLACK_CONFIG_TOKEN:?'SLACK_CONFIG_TOKEN 필요 (xoxe-...)'}"
APP_NAME="${SLACK_APP_NAME:-Claude Code Bot (New)}"

MANIFEST=$(cat << MANIFEST_EOF
{
    "display_information": {
        "name": "${APP_NAME}",
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
            "display_name": "${APP_NAME}",
            "always_online": true
        }
    },
    "oauth_config": {
        "scopes": {
            "bot": [
                "assistant:write", "app_mentions:read", "channels:history",
                "chat:write", "chat:write.public", "im:history",
                "im:read", "im:write", "users:read",
                "reactions:read", "reactions:write"
            ]
        }
    },
    "settings": {
        "event_subscriptions": {
            "bot_events": ["app_mention", "message.im", "member_joined_channel"]
        },
        "interactivity": { "is_enabled": false },
        "org_deploy_enabled": false,
        "socket_mode_enabled": true,
        "token_rotation_enabled": false
    }
}
MANIFEST_EOF
)

RESPONSE=$(curl -s -X POST "https://slack.com/api/apps.manifest.create" \
    -H "Authorization: Bearer ${SLACK_CONFIG_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"manifest\": $(echo "$MANIFEST" | jq -c .)}")

OK=$(echo "$RESPONSE" | jq -r '.ok')
if [ "$OK" != "true" ]; then
    echo "ERROR: $(echo "$RESPONSE" | jq -r '.error')"
    exit 1
fi

APP_ID=$(echo "$RESPONSE" | jq -r '.app_id')
SIGNING_SECRET=$(echo "$RESPONSE" | jq -r '.credentials.signing_secret')

echo "=== Slack App Created ==="
echo "App ID:         $APP_ID"
echo "Signing Secret: $SIGNING_SECRET"
echo ""
echo ">>> 웹에서 수동 작업 필요: <<<"
echo "1. https://api.slack.com/apps/${APP_ID} → Install App → Bot Token (xoxb-...) 복사"
echo "2. Basic Information → App-Level Tokens → Generate (connections:write) → App Token (xapp-...) 복사"
```

### 7.3 방법 C: 웹 UI (완전 수동)

1. https://api.slack.com/apps → **Create New App** → **From a manifest** 선택
2. 워크스페이스 선택
3. `slack-app-manifest.yaml` 내용 붙여넣기 (앱 이름은 환경별로 수정)
4. **Create** 클릭

생성 후 토큰 확인:

| 토큰 | 위치 | 형식 |
|------|------|------|
| Bot Token | OAuth & Permissions → Bot User OAuth Token | `xoxb-...` |
| App Token | Basic Information → App-Level Tokens → Generate (scope: `connections:write`) | `xapp-...` |
| Signing Secret | Basic Information → App Credentials → Signing Secret | 32자 hex |

### 7.4 자동화 한계 (Slack 제약)

| 항목 | Slack CLI | Manifest API | 웹 UI |
|------|-----------|--------------|-------|
| 앱 생성 | `slack run` 시 자동 | API 호출 | 수동 |
| 워크스페이스 설치 | `slack run` 시 자동 | OAuth 흐름 필요 (수동) | 버튼 클릭 |
| Bot Token (xoxb) | 자동 주입 (개발) | 설치 후 웹에서 확인 | 웹에서 확인 |
| App Token (xapp) | 자동 주입 (개발) | **API 미지원** (웹 수동) | 웹에서 생성 |
| Signing Secret | 앱 설정에서 확인 | API 응답에 포함 | 웹에서 확인 |
| 매니페스트 업데이트 | 자동 (파일 저장 시) | API 호출 | 수동 |

> **결론**: Slack CLI가 가장 자동화 수준이 높지만, **프로덕션용 토큰 3개는
> 앱 설정 웹페이지에서 1회 확인이 필요**하다. 이것은 Slack의 보안 정책상 불가피.

---

## 8. 설정 파일 작성

### 8.1 .env 파일

```bash
DEPLOY_DIR="${DEPLOY_DIR:-/opt/soma-work/dev}"

cat > "${DEPLOY_DIR}/.env" << 'ENV_EOF'
# === Slack (필수) ===
SLACK_BOT_TOKEN=xoxb-PASTE-HERE
SLACK_APP_TOKEN=xapp-PASTE-HERE
SLACK_SIGNING_SECRET=PASTE-HERE

# === 작업 디렉토리 (필수) ===
BASE_DIRECTORY=/tmp

# === Claude Code (선택) ===
# ANTHROPIC_API_KEY=sk-ant-...
# CLAUDE_CODE_USE_BEDROCK=1
# CLAUDE_CODE_USE_VERTEX=1

# === GitHub App (선택 - 권장) ===
# GITHUB_APP_ID=123456
# GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
# GITHUB_INSTALLATION_ID=12345678

# === GitHub Token (선택 - 레거시) ===
# GITHUB_TOKEN=ghp_...

# === Jira (선택) ===
# JIRA_BASE_URL=https://your-org.atlassian.net
# JIRA_EMAIL=your-email@example.com
# JIRA_API_TOKEN=...

# === 기타 (선택) ===
# DEFAULT_UPDATE_CHANNEL=#ai
# DEBUG=true
# DISPATCH_MODEL=claude-haiku-4-5-20251001
ENV_EOF

chmod 600 "${DEPLOY_DIR}/.env"
echo ">>> .env 파일 생성됨. 토큰 값을 직접 입력하세요."
```

### 8.2 .system.prompt 파일

```bash
cat > "${DEPLOY_DIR}/.system.prompt" << 'PROMPT_EOF'
# Facts
## Repository
- https://github.com/2lab-ai/soma/
- https://github.com/2lab-ai/soma-work/
  - PR target: main
PROMPT_EOF
```

### 8.3 config.json 파일

```bash
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
      {
        "name": "soma-work",
        "repo": "2lab-ai/soma-work",
        "ref": "main"
      }
    ],
    "plugins": [
      "omc@soma-work"
    ],
    "localOverrides": []
  }
}
CONFIG_EOF
```

### 8.4 mcp-servers.json 파일

```bash
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
```

---

## 9. GitHub Environments 설정

새로운 브랜치를 배포하려면 `deploy.yml`에 브랜치를 추가하고, GitHub Environment를 설정해야 한다.

### 9.1 deploy.yml 수정

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches:
      - main
      - deploy/prod
      - staging    # ← 새 브랜치 추가
```

### 9.2 deploy.yml 환경 매핑 수정

현재 `deploy.yml`은 `main -> /opt/soma-work/dev`, `deploy/prod -> /opt/soma-work/main` 으로 분기한다. 추가 환경을 지원하려면:

```yaml
      - name: Determine environment
        id: env
        run: |
          case "${{ github.ref_name }}" in
            main)    echo "env=dev" >> "$GITHUB_OUTPUT" ;;
            deploy/prod) echo "env=main" >> "$GITHUB_OUTPUT" ;;
            staging) echo "env=staging" >> "$GITHUB_OUTPUT" ;;
            *)       echo "env=dev" >> "$GITHUB_OUTPUT" ;;
          esac
```

### 9.3 GitHub Environment 생성 (gh CLI)

```bash
REPO="${REPO:-2lab-ai/soma-work}"
ENV_NAME="staging"      # environment 이름
BRANCH_NAME="staging"   # 배포 브랜치

# Environment 생성
gh api -X PUT "repos/${REPO}/environments/${ENV_NAME}" \
    --input - << JSON
{
    "deployment_branch_policy": {
        "protected_branches": false,
        "custom_branch_policies": true
    }
}
JSON

# Branch policy 추가
gh api -X POST "repos/${REPO}/environments/${ENV_NAME}/deployment-branch-policies" \
    --field name="${BRANCH_NAME}" \
    --field type="branch"

echo "Environment '${ENV_NAME}' 생성 완료 (branch: ${BRANCH_NAME})"
```

### 9.4 service.sh 커스텀 환경 지원

`service.sh`는 기본적으로 `main`과 `dev`만 인식한다. 커스텀 환경을 추가하려면:

```bash
# service.sh의 resolve_env() 함수에 추가 필요:
# staging)
#     SERVICE_NAME="ai.2lab.soma-work.staging"
#     PROJECT_DIR="/opt/soma-work/staging"
#     ;;

# 또는 현재 디렉토리 모드로 사용:
cd /opt/soma-work/staging
/path/to/service.sh install    # ENV_ARG 없이 = 현재 디렉토리 사용
```

> **Tip**: main/dev 이외 환경은 `service.sh`를 직접 수정하거나,
> 배포 디렉토리에서 직접 `node dist/index.js`로 실행.

---

## 10. 첫 배포 트리거

### 10.1 브랜치 생성 및 푸시

```bash
# 로컬 레포에서
git checkout -b staging
git push -u origin staging
```

### 10.2 배포 확인

```bash
# GitHub Actions 실행 상태 확인
gh run list --repo ${REPO} --branch staging --limit 3

# 특정 실행 로그 확인
gh run view <RUN_ID> --repo ${REPO} --log
```

### 10.3 수동 배포 (CI 없이)

CI 설정 전이거나 급한 경우:

```bash
cd /opt/soma-work/${DEPLOY_ENV}
git pull origin ${DEPLOY_BRANCH}
npm ci
npm run build

# service.sh로 재시작
/path/to/service.sh ${DEPLOY_ENV} reinstall
# 또는 직접
/path/to/service.sh ${DEPLOY_ENV} stop
/path/to/service.sh ${DEPLOY_ENV} start
```

---

## 11. 서비스 검증

### 11.1 서비스 상태 확인

```bash
# service.sh 사용
./service.sh ${DEPLOY_ENV} status

# 또는 직접 확인
launchctl list | grep soma-work

# 로그 확인
./service.sh ${DEPLOY_ENV} logs stderr 50
./service.sh ${DEPLOY_ENV} logs follow    # 실시간
```

### 11.2 Slack 연결 확인

```bash
# 로그에서 Slack 연결 메시지 확인
grep -i "connected\|socket\|ready" /opt/soma-work/${DEPLOY_ENV}/logs/stderr.log | tail -5
```

### 11.3 봇 응답 테스트

Slack에서:
1. 봇에게 DM: "안녕"
2. 채널에서 @mention: "@Claude Code 안녕"
3. 응답이 오면 성공

---

## 12. Slack 채널 설정

### 12.1 전용 채널 생성

각 배포 환경에 전용 채널을 만들어 사용:

```bash
# Slack API로 채널 생성 (Bot Token 필요)
# 참고: channels:manage scope이 추가로 필요할 수 있음

# 수동이 더 간단:
# Slack에서 #workspace-staging 채널 생성 → 봇 초대
```

### 12.2 봇을 채널에 초대

채널에서 `/invite @앱이름` 또는 앱 이름을 mention하면 자동 초대 프롬프트가 뜸.

### 12.3 채널별 CWD 설정

채널에서 봇에게:
```
cwd /path/to/project
```

---

## 13. 트러블슈팅

### 서비스가 시작되지 않음

```bash
# 로그 확인
./service.sh ${DEPLOY_ENV} logs stderr 100

# .env 파일 확인
cat /opt/soma-work/${DEPLOY_ENV}/.env | head -5

# 토큰 형식 확인
grep "^SLACK_BOT_TOKEN=" /opt/soma-work/${DEPLOY_ENV}/.env | cut -c1-15
# → "SLACK_BOT_TOKEN=xoxb-" 이어야 함
```

### Runner가 offline

```bash
# Runner 서비스 상태
cd ~/actions-runner
./svc.sh status

# 재시작
./svc.sh stop
./svc.sh start

# 재등록 (토큰 만료 시)
REG_TOKEN=$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" --jq '.token')
./config.sh remove --token "$REG_TOKEN"
./config.sh --url "https://github.com/${REPO}" --token "$REG_TOKEN" --name "$(hostname -s)" \
    --labels "self-hosted,macOS,ARM64,soma-work" --unattended --replace
./svc.sh install
./svc.sh start
```

### 듀얼 인스턴스 충돌

**증상**: 메시지가 두 번 오거나, 응답이 끊김
**원인**: 같은 Slack 토큰으로 2개 인스턴스 실행
**해결**: 하나를 중지하거나, 각각 다른 Slack 앱 사용

```bash
# 모든 soma-work 서비스 상태 확인
./service.sh status-all

# 충돌하는 인스턴스 중지
./service.sh dev stop
```

### 배포 후 서비스가 구 버전

```bash
# dist/version.json 확인
cat /opt/soma-work/${DEPLOY_ENV}/dist/version.json | jq '.version, .commitHashShort'

# 수동 빌드 후 재시작
cd /opt/soma-work/${DEPLOY_ENV}
git pull
npm ci && npm run build
./service.sh ${DEPLOY_ENV} restart
```

---

## 부록 A: 3-Phase 배포 스크립트

`scripts/new-deploy-setup.sh` — 3단계 구조의 배포 자동화 스크립트.

```
Phase 1: Prerequisites    ← 모든 도구 idempotent 설치 (유저 입력 없음)
Phase 2: User Input        ← 로그인, 인증, 환경변수 (한번에 모두 수집)
Phase 3: Unattended Setup  ← 나머지 전부 자동 (유저 입력 없음)
```

### 사용법

```bash
# 기본 (대화형으로 설정 입력)
./scripts/new-deploy-setup.sh

# 환경변수로 미리 설정 (비대화형에 가까움)
DEPLOY_ENV=staging \
DEPLOY_BRANCH=staging \
SLACK_APP_NAME="Claude Code (Staging)" \
BOT_DISPLAY_NAME="Claude Code" \
BOT_ICON_PATH="~/bot.png" \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
SLACK_SIGNING_SECRET=abc123 \
./scripts/new-deploy-setup.sh

# 중단 후 재실행 (완료된 단계는 건너뜀)
./scripts/new-deploy-setup.sh
```

### Phase별 상세

**Phase 1: Prerequisites** (자동, idempotent)
- Homebrew 설치/확인
- node, git, gh, jq, curl 설치/확인
- Slack CLI 설치/확인
- GitHub Actions Runner 바이너리 다운로드

**Phase 2: User Input** (한번에 모든 입력 수집)
- 배포 환경 설정 (DEPLOY_ENV, DEPLOY_BRANCH, REPO, BASE_DIRECTORY)
- Slack 봇 설정 (SLACK_APP_NAME, BOT_DISPLAY_NAME, BOT_ICON_PATH)
- GitHub CLI 로그인 (`gh auth login`)
- Slack CLI 로그인 (`slack login`)
- Slack 토큰 입력 (있으면) 또는 나중에 수집 선택
- Anthropic API Key, GitHub Token (선택)

**Phase 3: Unattended** (자동, 유저 입력 없음)
1. 배포 디렉토리 생성 + 클론 + 빌드
2. Slack CLI 초기화 + manifest.json 생성
3. 설정 파일 생성 (.env, .system.prompt, mcp-servers.json, config.json)
4. GitHub Actions Runner 등록
5. GitHub Environment 설정
6. LaunchAgent 서비스 설치
7. Slack 토큰 수집 (Phase 2에서 안 했으면)
8. 봇 아이콘 업로드 안내
9. 서비스 시작 + 검증

### State 파일

`.new-deploy-state`에 진행 상태를 저장하여 **중단 후 재실행 시 완료된 단계를 건너뜀**.

```bash
# State 초기화 (처음부터 다시 하려면)
rm .new-deploy-state
```

---

## 부록 B: AI 에이전트용 실행 체크리스트

AI 에이전트가 이 매뉴얼을 기반으로 배포할 때 참조하는 체크리스트.

### 입력 파라미터

```yaml
required:
  SERVER_HOST: "배포 서버 SSH 주소"
  SERVER_USER: "SSH 유저"
  SLACK_BOT_TOKEN: "xoxb-..."           # slack run 후 앱 설정에서 확인
  SLACK_APP_TOKEN: "xapp-..."           # slack run 후 앱 설정에서 생성
  SLACK_SIGNING_SECRET: "32자 hex"      # slack run 후 앱 설정에서 확인

bot_config:
  SLACK_APP_NAME: "Claude Code Bot"     # Slack 앱 이름 (→ @handle 자동 생성)
  BOT_DISPLAY_NAME: "Claude Code"       # 봇 표시 이름
  BOT_ICON_PATH: "~/bot.png"           # 봇 프로필 이미지 (수동 업로드 필요)

optional:
  DEPLOY_ENV: "dev"                    # 기본값
  DEPLOY_BRANCH: "main"               # 기본값 (dev 환경 기준)
  REPO: "2lab-ai/soma-work"           # 기본값
  BASE_DIRECTORY: "/tmp"              # 기본값
  ANTHROPIC_API_KEY: ""
  GITHUB_TOKEN: ""
```

### 실행 순서

```
[ ] 1. SSH 접속 가능 확인
      ssh ${SERVER_USER}@${SERVER_HOST} "echo OK"

[ ] 2. 필수 도구 확인/설치
      node, npm, git, gh, jq, curl

[ ] 3. GitHub CLI 인증
      gh auth status

[ ] 4. 배포 디렉토리 생성
      /opt/soma-work/${DEPLOY_ENV}/

[ ] 5. 소스 클론 + 빌드
      git clone → npm ci → npm run build

[ ] 6. Slack CLI 로그인
      slack login (또는 --no-prompt + --ticket + --challenge)

[ ] 7. Slack CLI 프로젝트 초기화
      npm install --save-dev @slack/cli-hooks && slack init

[ ] 8. manifest.json 생성 (SLACK_APP_NAME, BOT_DISPLAY_NAME 반영)
      /opt/soma-work/${DEPLOY_ENV}/manifest.json

[ ] 9. Slack 앱 생성 + 설치
      slack run (첫 실행 시 자동 생성/설치)

[ ] 10. 봇 프로필 이미지 업로드 (수동)
       slack app settings → Display Information → App Icon
       → BOT_ICON_PATH 파일 업로드

[ ] 11. 프로덕션 토큰 확보 (수동)
       slack app settings → Bot Token(xoxb), App Token(xapp), Signing Secret
       → .env에 기록

[ ] 12. .env 파일 작성 (토큰 삽입)
       /opt/soma-work/${DEPLOY_ENV}/.env

[ ] 13. .system.prompt 생성
       /opt/soma-work/${DEPLOY_ENV}/.system.prompt

[ ] 14. mcp-servers.json 생성
       /opt/soma-work/${DEPLOY_ENV}/mcp-servers.json

[ ] 15. config.json 생성
       /opt/soma-work/${DEPLOY_ENV}/config.json

[ ] 16. GitHub Runner 등록
       ~/actions-runner/ → config → svc.sh install

[ ] 17. deploy.yml에 브랜치 추가 (필요 시)
       .github/workflows/deploy.yml

[ ] 18. GitHub Environment 생성 (필요 시)
       gh api repos/.../environments/...

[ ] 19. LaunchAgent 서비스 설치
       service.sh ${DEPLOY_ENV} install

[ ] 20. 서비스 상태 확인
       service.sh ${DEPLOY_ENV} status → RUNNING

[ ] 21. Slack 연결 확인
       로그에 "connected" 메시지 있는지 확인

[ ] 22. 봇 응답 테스트
       Slack DM으로 메시지 전송 → 응답 확인
```

### 실패 시 롤백

```bash
# 서비스 중지
./service.sh ${DEPLOY_ENV} stop

# Runner 제거
cd ~/actions-runner && ./svc.sh stop && ./svc.sh uninstall

# 디렉토리 정리
rm -rf /opt/soma-work/${DEPLOY_ENV}
```

---

## 부록 C: 다중 Runner 환경에서 특정 노드 배포

여러 서버에 Runner가 등록된 경우, 특정 노드에서만 특정 브랜치를 배포하려면:

### Runner 레이블 전략

```bash
# 서버 A (deploy/prod 전용)
./config.sh ... --labels "self-hosted,macOS,ARM64,soma-work,prod-node"

# 서버 B (main 전용 dev 배포)
./config.sh ... --labels "self-hosted,macOS,ARM64,soma-work,dev-node"
```

### Workflow 매트릭스

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on:
      - self-hosted
      - soma-work
      - ${{ github.ref_name == 'deploy/prod' && 'prod-node' || 'dev-node' }}
```

현재 워크플로우에서는 main 브랜치가 macmini와 oudwood-512의 `/opt/soma-work/dev`로 배포되고,
deploy/prod 브랜치는 macmini의 `/opt/soma-work/main`으로 배포된다.
