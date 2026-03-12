# Slack CLI Reference (soma-work)

> Slack CLI를 사용한 Bolt 앱 관리 가이드.
> soma-work 프로젝트에 특화된 실용 레퍼런스.

## 개요

Slack CLI v3.13+는 전통적인 **Bolt 앱**도 지원한다 (이전에는 Deno 기반 next-gen 앱만 지원).
`bolt` / `bolt-install` experiment를 통해 Bolt JS/Python 프로젝트에서 CLI를 사용할 수 있다.

**핵심 가치**: `slack run` 한 번으로 **앱 생성 + 워크스페이스 설치 + 토큰 자동 관리** 가능.

### 공식 문서

- [Slack CLI + Bolt Framework 가이드](https://docs.slack.dev/tools/slack-cli/guides/using-slack-cli-with-bolt-frameworks/)
- [Slack CLI Experiments](https://docs.slack.dev/tools/slack-cli/reference/experiments/)
- [Slack CLI Hooks Reference](https://docs.slack.dev/tools/slack-cli/reference/hooks/)
- [Slack CLI 지원 발표 (Bolt)](https://slack.dev/slackcli-supports-bolt-apps/)

---

## 설치

```bash
# macOS / Linux
curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash

# 버전 확인
slack version

# 환경 진단
slack doctor
```

설치 위치: `~/.slack/bin/slack`

---

## 인증

### 대화형 로그인

```bash
slack login
# → 브라우저 URL이 출력됨 → 브라우저에서 열고 챌린지 코드 입력
```

### 비대화형 로그인 (서버/CI)

```bash
# 1단계: 티켓 발급 (서버에서)
slack auth login --no-prompt
# → 티켓과 URL 출력됨

# 2단계: 브라우저에서 URL 열고 챌린지 코드 확인

# 3단계: 서버에서 인증 완료
slack auth login --ticket "ISQWLi..." --challenge "6d0a31c9"
```

### 서비스 토큰 (CI/CD)

```bash
slack auth token
# → 서비스 토큰 발급 (자동 인증용)

# 비대화형
slack auth token --no-prompt
# → 티켓 발급됨 → 챌린지 코드로 완료
```

### 인증 상태 확인

```bash
slack auth list
# 출력 예:
# insightquesthq (Team ID: T086X6RS41W)
# User ID: U09F1M5MML1
# Authorization Level: Workspace
```

### 인증 저장 위치

```
~/.slack/
├── config.json        # CLI 설정 (system_id, experiments)
└── credentials.json   # 워크스페이스별 인증 토큰
```

`credentials.json` 구조:
```json
{
  "T086X6RS41W": {
    "token": "xoxe.xoxp-...",
    "team_domain": "insightquesthq",
    "team_id": "T086X6RS41W",
    "user_id": "U09F1M5MML1",
    "refresh_token": "xoxe-1-...",
    "exp": 1772718891
  }
}
```

---

## Bolt 앱 통합

### @slack/cli-hooks 패키지

Bolt for JavaScript ↔ Slack CLI 간의 브릿지. CLI가 hooks를 통해 앱을 제어.

```bash
npm install --save-dev @slack/cli-hooks
```

**제공 바이너리:**
- `slack-cli-get-hooks` — 사용 가능한 훅 목록 반환
- `slack-cli-get-manifest` — manifest.json 반환
- `slack-cli-start` — 앱 시작 (Socket Mode 연결)
- `slack-cli-check-update` — SDK 업데이트 확인
- `slack-cli-doctor` — 환경 진단

### 프로젝트 초기화 (`slack init`)

```bash
cd /path/to/bolt-project
slack init
```

**생성되는 파일:**

```
.slack/
├── .gitignore          # apps.json, apps.dev.json 무시
├── apps.json           # 프로덕션 앱 ID ↔ 워크스페이스 매핑
├── apps.dev.json       # 개발용 앱 매핑
├── config.json         # manifest source (remote/local)
└── hooks.json          # CLI 훅 정의 (get-hooks만 기본)
```

**hooks.json 기본 구조:**
```json
{
  "hooks": {
    "get-hooks": "npx -q --no-install -p @slack/cli-hooks slack-cli-get-hooks"
  }
}
```

실제 훅은 `@slack/cli-hooks`가 `get-hooks` 응답에서 동적으로 반환:
```json
{
  "hooks": {
    "get-manifest": "npx -q --no-install -p @slack/cli-hooks slack-cli-get-manifest",
    "start": "npx -q --no-install -p @slack/cli-hooks slack-cli-start",
    "check-update": "npx -q --no-install -p @slack/cli-hooks slack-cli-check-update",
    "doctor": "npx -q --no-install -p @slack/cli-hooks slack-cli-doctor"
  },
  "config": {
    "watch": {
      "manifest": { "paths": ["manifest.json"] },
      "app": { "paths": ["."], "filter-regex": "\\.(js|ts)$" }
    },
    "protocol-version": ["message-boundaries"],
    "sdk-managed-connection-enabled": true
  }
}
```

### manifest.json

Slack CLI는 JSON 형식의 매니페스트를 사용 (기존 YAML이 아님).
프로젝트 루트에 `manifest.json` 배치.

```json
{
    "display_information": {
        "name": "Claude Code Bot",
        "description": "AI-powered coding assistant",
        "background_color": "#4A154B"
    },
    "features": {
        "app_home": {
            "home_tab_enabled": false,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": false
        },
        "bot_user": {
            "display_name": "Claude Code",
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
```

---

## 핵심 명령어

### `slack run` — 개발 모드 실행

```bash
slack run
```

**첫 실행 시 자동 수행:**
1. `manifest.json`으로 Slack 앱 생성 (api.slack.com/apps에 등록)
2. 선택한 워크스페이스에 설치
3. Bot Token(`xoxb-...`), App Token(`xapp-...`) 자동 발급
4. 환경변수로 앱에 자동 주입
5. Socket Mode 연결
6. 파일 변경 시 자동 재시작 (v3.12+)

**주입되는 환경변수:**
| 변수 | 값 |
|------|-----|
| `SLACK_BOT_TOKEN` | `xoxb-...` (봇 토큰) |
| `SLACK_APP_TOKEN` | `xapp-...` (앱 레벨 토큰) |
| `SLACK_CLI_XOXB` | `xoxb-...` (동일) |
| `SLACK_CLI_XAPP` | `xapp-...` (동일) |

### `slack app install` — 워크스페이스 설치

```bash
# 기본 (프롬프트)
slack app install

# 특정 팀에 프로덕션 앱 설치
slack app install --team T0123456 --environment deployed

# 로컬 개발 앱 설치
slack app install --team T0123456 --environment local
```

### `slack app link` — 기존 앱 연결

이미 웹에서 만든 앱을 CLI 프로젝트에 연결:

```bash
# 대화형
slack app link

# 비대화형
slack app link --team T0123456789 --app A0123456789 --environment deployed
```

### `slack manifest` — 매니페스트 관리

```bash
# 현재 매니페스트 확인 (로컬)
slack manifest info

# 리모트(앱 설정) 매니페스트 확인
slack manifest info --source remote

# 특정 앱의 매니페스트
slack manifest info --app A0123456789

# 매니페스트 유효성 검사
slack manifest validate
```

### 기타 관리 명령

```bash
slack app list           # 앱 설치된 팀 목록
slack app settings       # 브라우저에서 앱 설정 열기
slack app uninstall      # 워크스페이스에서 제거
slack app delete         # 앱 삭제
slack auth list          # 인증된 계정 목록
slack auth logout        # 로그아웃
slack doctor             # 환경 진단
```

---

## Manifest 관리 전략 (remote vs local)

### Remote (기본값, 권장)

앱 설정 페이지가 매니페스트의 source of truth. `slack run` 시 앱 설정에서 매니페스트를 가져옴.

```json
// .slack/config.json
{
  "manifest-source": "remote"
}
```

**장점**: 웹 UI에서 변경해도 즉시 반영
**단점**: 로컬 파일과 불일치 가능

### Local

프로젝트의 `manifest.json`이 source of truth. 재설치 시 로컬 매니페스트로 앱 설정을 덮어씀.

```json
// .slack/config.json
{
  "manifest-source": "local"
}
```

**장점**: Git 추적 가능, 코드와 함께 버전 관리
**단점**: 재설치마다 확인 프롬프트

---

## 토큰 관리 전략

### 개발 환경 (자동)

`slack run` → 토큰 자동 주입. .env 불필요.

### 프로덕션 환경 (수동 1회)

`slack run`으로 앱 생성 후, 프로덕션 배포용 토큰 확보:

1. **Bot Token**: `slack app settings` → OAuth & Permissions → Bot User OAuth Token
2. **App Token**: `slack app settings` → Basic Information → App-Level Tokens → Generate
   - Token Name: `socket-mode`
   - Scope: `connections:write`
3. **Signing Secret**: `slack app settings` → Basic Information → App Credentials

이 3개 값을 `.env`에 기록하면 프로덕션 배포 준비 완료.

```bash
# .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-1-...
SLACK_SIGNING_SECRET=abc123...
```

---

## 자동화 한계

| 기능 | CLI 자동화 | 수동 필요 이유 |
|------|-----------|--------------|
| 앱 생성 | `slack run` 자동 | - |
| 워크스페이스 설치 | `slack run` 자동 | - |
| Bot Token 발급 | 자동 (개발 모드) | 프로덕션: 웹에서 확인 |
| App Token 생성 | 자동 (개발 모드) | 프로덕션: 웹에서 생성 (API 미지원) |
| 매니페스트 업데이트 | 파일 저장 시 자동 반영 | - |
| Signing Secret | 앱 생성 시 자동 발급 | 웹에서 확인 필요 |
| 로그인 | 반자동 (챌린지 코드) | 최소 1회 브라우저 필요 |

**결론**: 개발은 100% 자동화, 프로덕션은 **토큰 3개만 웹에서 1회 확인** 필요.
이것은 Slack의 보안 정책(토큰 노출 방지)상 불가피한 제약.

---

## soma-work에서의 사용

### 새 환경 배포 흐름

```bash
# 1. 서버에서 Slack CLI 로그인
slack login

# 2. 배포 디렉토리에서 초기화
cd /opt/soma-work/dev
npm install --save-dev @slack/cli-hooks
slack init

# 3. manifest.json 생성 (앱 이름을 환경별로 다르게)
# → manifest.json의 display_information.name 수정

# 4. 앱 생성 + 개발 테스트
slack run
# → 잘 동작하면 Ctrl+C

# 5. 프로덕션 토큰 확보
slack app settings
# → 웹에서 토큰 3개 복사 → .env에 기록

# 6. 프로덕션 서비스 시작
./service.sh dev install
```

### 기존 앱 연결 (이미 웹에서 만든 경우)

```bash
cd /opt/soma-work/dev
slack app link --team T086X6RS41W --app A0123456789 --environment deployed
```

### 매니페스트 업데이트 (권한 추가 등)

```bash
# manifest.json 수정
vim manifest.json

# 유효성 검사
slack manifest validate

# 반영 (재설치)
slack app install
```
