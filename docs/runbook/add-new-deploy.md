# 신규 노드 배포 가이드 (플릿 배포 — 레거시)

> **이 문서가 다루는 것**: GitHub self-hosted runner + `/opt/soma-work/<env>` +
> `scripts/service.sh` 로 굴러가는 **기존 플릿 배포**에 macOS 노드를 하나 더 붙이는 절차.
> 지금 돌아가는 배포는 이것이며, 이 문서는 계속 유효하다.
>
> **이 문서가 다루지 않는 것**: 새 프로파일 패키지 온보딩(`somawork setup`). 그쪽은 노드도
> runner도 `/opt`도 `.env`도 쓰지 않고, 한 명령이 llmux·Slack·프로파일·서비스를 전부 세운다.
> 개요와 **현재 상태**(포뮬러 미배포, clean-machine·실 Slack 리시트 없음)는 `README.md`의
> "Getting soma-work running"을 보라. 둘은 **다른 배포 모델**이고 경로도 서비스 레이블도
> 겹치지 않는다.

**이 문서에서 삭제된 것** (되살리지 마라):

- Slack CLI로 토큰을 뽑아내던 hooks.json 교체 트릭, Manifest API용 **configuration token**
  발급 절차, 세 가지 앱 생성 "방법 A/B/C" 비교표. 토큰을 손으로 옮기는 경로는 새 온보딩이
  대체했고, 플릿 노드에 남는 수동 절차는 §7 하나로 충분하다.
- 3-Phase 자동화 스크립트 부록. `scripts/new-deploy-setup.sh`는 이제
  `somawork setup`으로 `exec` 하는 deprecation shim이며, 토큰을 묻지도 `/opt`를 만들지도
  않는다. 그 문서를 유지하면 존재하지 않는 절차를 안내하게 된다.
- AI 에이전트용 실행 체크리스트 부록. 본문 §3–§12의 중복이었다.

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
14. [부록: 다중 Runner 환경에서 특정 노드 배포](#부록-다중-runner-환경에서-특정-노드-배포)

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
> 앱 설정 페이지에서 직접 올린다 (§7). `BOT_ICON_PATH`는 안내용 값일 뿐이다.

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

# 클론 (또는 scripts/service.sh setup 사용)
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

플릿 노드는 환경마다 **전용 Slack 앱 1개**를 쓴다 (같은 토큰으로 두 인스턴스를 돌리면 메시지가
중복/충돌한다). 노드에는 패키징된 런타임이 없으므로 여기서는 웹 UI 수동 경로 하나만 쓴다.

1. https://api.slack.com/apps → **Create New App** → **From a manifest**
2. 워크스페이스 선택
3. `infra/slack/slack-app-manifest.json` 내용을 붙여넣는다.

   > ⚠️ 매니페스트의 앱 이름은 **`Somawork`** 다. 기존 앱에 이 매니페스트를 업로드하면
   > **그 앱과 봇의 표시 이름이 함께 바뀐다.** 환경별 이름을 유지하려면 저장 전에
   > `display_information.name` 과 `features.bot_user.display_name` 을 수정하라.
4. **Create**

생성 후 §8.1에 넣을 값 두 개를 확인한다:

| 값 | 위치 | 형식 |
|------|------|------|
| Bot Token | OAuth & Permissions → Bot User OAuth Token | `xoxb-...` |
| App Token | Basic Information → App-Level Tokens → Generate (scope: `connections:write`) | `xapp-...` |

**Signing Secret은 필요 없다.** 매니페스트가 Socket Mode를 켜므로 HTTP 서명 검증 경로를 쓰지
않는다. `SLACK_SIGNING_SECRET`은 HTTP 엔드포인트를 직접 노출할 때만 의미가 있다.

봇 아이콘은 Slack API에 업로드 엔드포인트가 없다 — 앱 설정 페이지에서 직접 올린다
(`open "https://api.slack.com/apps/<APP_ID>/general"`).

> 프로파일 패키지 경로에서는 이 절 전체가 자동이다: Slack CLI 티켓/챌린지로 인가하고,
> 패키징된 매니페스트로 앱을 만들고, 런타임 토큰은 훅에서 프로파일 전용 Unix 소켓을 거쳐
> `0600 secrets.env`로 들어간다. 사람이 토큰을 보거나 복사하는 단계가 없다.

---

## 8. 설정 파일 작성

### 8.1 .env 파일

플릿 노드의 런타임 자격증명은 여기 산다. 배포 시 rsync exclude로 보존된다.

```bash
DEPLOY_DIR="${DEPLOY_DIR:-/opt/soma-work/dev}"

cat > "${DEPLOY_DIR}/.env" << 'ENV_EOF'
# === Slack (필수) ===
SLACK_BOT_TOKEN=xoxb-PASTE-HERE
SLACK_APP_TOKEN=xapp-PASTE-HERE

# === 작업 디렉토리 (필수) ===
BASE_DIRECTORY=/tmp
ENV_EOF

chmod 600 "${DEPLOY_DIR}/.env"
echo ">>> .env 생성됨. 토큰 값을 직접 입력하세요."
```

선택 항목(`ANTHROPIC_API_KEY`, `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID`,
`GITHUB_TOKEN`, `JIRA_*`, `DEFAULT_UPDATE_CHANNEL`, `DEBUG`, `DISPATCH_MODEL`, Bedrock/Vertex
플래그)의 목록과 의미는 `README.md`의 소스 개발 경로 §3에 있다 — 여기에 복붙해 두면 두 곳이
어긋난다.

`SLACK_SIGNING_SECRET`은 넣지 않는다 (§7 참조).

### 8.2 .system.prompt 파일

패키징된 중립 기본값을 복사한 뒤 이 노드에 맞게 고친다:

```bash
cp .system.prompt.example "${DEPLOY_DIR}/.system.prompt"
```

`.system.prompt.example`은 런타임 루트에 실려 있는 canonical 입력이며, 자격증명도 머신 고유
절대경로도 사설 호스트명도 담지 않는다. 이 노드가 다루는 레포 목록 같은 값은 복사본에만 적는다.

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
      "zworkflow@soma-work"
    ],
    "localOverrides": []
  }
}
CONFIG_EOF
```

### 8.4 (제거됨) mcp-servers.json

`mcpServers` 섹션은 `config.json` 안에 통합됨 — 별도 파일 생성 불필요. PR #808 참조.

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

### 9.4 scripts/service.sh 커스텀 환경 지원

`scripts/service.sh`는 기본적으로 `main`과 `dev`만 인식한다. 커스텀 환경을 추가하려면:

```bash
# scripts/service.sh의 resolve_env() 함수에 추가 필요:
# staging)
#     SERVICE_NAME="ai.2lab.soma-work.staging"
#     PROJECT_DIR="/opt/soma-work/staging"
#     ;;

# 또는 현재 디렉토리 모드로 사용:
cd /opt/soma-work/staging
/path/to/scripts/service.sh install    # ENV_ARG 없이 = 현재 디렉토리 사용
```

> **Tip**: main/dev 이외 환경은 `scripts/service.sh`를 직접 수정하거나,
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

# scripts/service.sh로 재시작
/path/to/scripts/service.sh ${DEPLOY_ENV} reinstall
# 또는 직접
/path/to/scripts/service.sh ${DEPLOY_ENV} stop
/path/to/scripts/service.sh ${DEPLOY_ENV} start
```

---

## 11. 서비스 검증

### 11.1 서비스 상태 확인

```bash
# scripts/service.sh 사용
./scripts/service.sh ${DEPLOY_ENV} status

# 또는 직접 확인
launchctl list | grep soma-work

# 로그 확인
./scripts/service.sh ${DEPLOY_ENV} logs stderr 50
./scripts/service.sh ${DEPLOY_ENV} logs follow    # 실시간
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
./scripts/service.sh ${DEPLOY_ENV} logs stderr 100

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
./scripts/service.sh status-all

# 충돌하는 인스턴스 중지
./scripts/service.sh dev stop
```

### 배포 후 서비스가 구 버전

```bash
# dist/version.json 확인
cat /opt/soma-work/${DEPLOY_ENV}/dist/version.json | jq '.version, .commitHashShort'

# 수동 빌드 후 재시작
cd /opt/soma-work/${DEPLOY_ENV}
git pull
npm ci && npm run build
./scripts/service.sh ${DEPLOY_ENV} restart
```

---

## (삭제됨) 부록 A · 부록 B

- **부록 A — 3-Phase 배포 스크립트.** `scripts/new-deploy-setup.sh`는 deprecation shim이 되었다:
  안내 한 줄을 출력하고 `somawork setup`으로 `exec` 한다 (`DEPLOY_ENV=dev` → `--profile preview`,
  `DEPLOY_ENV=main` → `--profile production`). 토큰 프롬프트, 레포 상대 `.env` 쓰기,
  `/opt/soma-work/<env>` 클론, `.new-deploy-state` 파일은 전부 삭제되었다. 플릿 노드는 이 문서
  §3–§12를 직접 따른다.
- **부록 B — AI 에이전트용 실행 체크리스트.** 본문의 중복이라 삭제했다. §3–§12가 그대로 실행
  순서다.

---

## 부록: 다중 Runner 환경에서 특정 노드 배포

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
