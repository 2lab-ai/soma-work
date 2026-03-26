# Admin Commands — Spec

> STV Spec | Created: 2026-03-06

## 1. Overview

Slack 봇의 admin 전용 관리 명령어 시스템. 3가지 핵심 기능:
1. **User Acceptance**: 신규 유저가 봇을 사용하려면 admin 승인 필요 (기존 유저는 자동 승인)
2. **Config Show/Set**: .env 환경변수를 런타임에서 조회/변경
3. **CCT 확장**: 기존 CCT 토큰 관리 명령어를 admin-handler로 통합

## 2. User Stories

- As an admin, I want to approve new users before they can use the bot, so that I control access
- As an admin, I want to view and change .env settings at runtime, so that I can reconfigure without restart
- As a new user, I want to see a clear "pending approval" message, so that I know my request was received
- As an admin, I want to be notified via DM with Accept/Deny buttons when a new user tries to use the bot

## 3. Acceptance Criteria

- [ ] 기존 user-settings.json에 레코드가 있는 유저는 `accepted: true`로 자동 마이그레이션
- [ ] 신규 유저 첫 메시지 → "승인 대기 중" 메시지 표시 + admin DM 알림 (Accept/Deny 버튼)
- [ ] admin이 Accept 클릭 → 유저 `accepted: true` 설정 + 유저에게 승인 알림 + 온보딩 시작
- [ ] admin이 Deny 클릭 → 유저에게 거부 알림
- [ ] `config show` → 모든 .env 변수 목록 표시 (시크릿은 마스킹)
- [ ] `config KEY=VALUE` → process.env + .env 파일 업데이트 + 특수 캐시 리셋
- [ ] 모든 admin 명령어는 `isAdminUser()` 체크 통과 필수
- [ ] `accept @user` / `deny @user` 명령어도 지원 (버튼 대안)

## 4. Scope

### In-Scope
- User acceptance gate (SessionInitializer에서 차단)
- Admin DM 알림 with interactive buttons (Accept/Deny)
- `accept @user` / `deny @user` 명령어
- `users` 명령어 (승인된/대기 중 유저 목록)
- `config show` 전체 .env 변수 표시
- `config KEY=VALUE` 런타임 변경 + .env 파일 반영
- 기존 유저 자동 마이그레이션 (`accepted: true`)
- 특수 캐시 리셋 (adminUsers, tokenManager 등)

### Out-of-Scope
- 역할 기반 권한 (admin/일반 외의 role)
- config.ts 객체 동적 갱신 (process.env만 업데이트, 서비스 재시작 시 config 객체 반영)
- 웹 UI 기반 설정 관리
- 감사 로그 (audit trail)

## 5. Architecture

### 5.1 Layer Structure

```
Slack Event → InputProcessor → SessionInitializer
                                    ↓
                            [acceptance gate] ← NEW
                                    ↓
                              (accepted) → normal flow
                              (pending)  → "대기 중" 메시지 + admin DM 알림

Admin Command → CommandRouter → AdminHandler ← NEW (replaces CctHandler routing)
                                    ↓
                            accept/deny/users/config
```

### 5.2 Command Structure

| Command | Description | Handler |
|---------|-------------|---------|
| `accept @user` | 유저 승인 | AdminHandler |
| `deny @user` | 유저 거부 | AdminHandler |
| `users` | 유저 목록 (승인/대기) | AdminHandler |
| `config show` | .env 변수 전체 표시 | AdminHandler |
| `config KEY=VALUE` | .env 변수 런타임 변경 | AdminHandler |
| `cct` | CCT 토큰 상태 | CctHandler (기존 유지) |
| `set_cct cctN` | CCT 토큰 전환 | CctHandler (기존 유지) |
| `nextcct` | CCT 토큰 로테이션 | CctHandler (기존 유지) |

### 5.3 Data Model Changes

**UserSettings 확장:**
```typescript
interface UserSettings {
  // ... existing fields ...
  accepted: boolean;        // NEW: admin 승인 여부
  acceptedBy?: string;      // NEW: 승인한 admin userId
  acceptedAt?: string;      // NEW: 승인 시각
}
```

**마이그레이션**: 기존 레코드에 `accepted` 필드가 없으면 `true`로 기본 설정 (grandfathering).

### 5.4 Acceptance Gate Flow

```
SessionInitializer.initialize()
  → userSettingsStore.getUserSettings(userId)
  → if no settings:
      → create pending record: { accepted: false, ... }
      → post "승인 대기 중" message to user thread
      → send admin DM with Accept/Deny buttons
      → return (do NOT proceed to onboarding/dispatch)
  → if settings.accepted === false:
      → post "아직 승인 대기 중" message
      → return
  → if settings.accepted === true:
      → normal flow (existing behavior)
```

### 5.5 Admin Notification (Interactive Buttons)

Slack Block Kit payload:
```json
{
  "text": "New user access request",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*New User Request*\n<@USER_ID> wants to use the bot" }
    },
    {
      "type": "actions",
      "block_id": "user_acceptance",
      "elements": [
        { "type": "button", "text": { "type": "plain_text", "text": "Accept" }, "action_id": "accept_user", "value": "USER_ID", "style": "primary" },
        { "type": "button", "text": { "type": "plain_text", "text": "Deny" }, "action_id": "deny_user", "value": "USER_ID", "style": "danger" }
      ]
    }
  ]
}
```

Action handler: `src/slack/actions/` 디렉토리에 새 action handler 추가.

### 5.6 Config Show/Set

**config show:**
- .env 파일을 읽어서 `KEY=VALUE` 목록 표시
- 시크릿 패턴 자동 감지 + 마스킹: `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PRIVATE` 포함 키
- 마스킹: 앞 4자 + `...` + 뒤 4자

**config KEY=VALUE:**
1. `process.env[KEY] = VALUE` 업데이트
2. .env 파일에서 해당 KEY 라인 교체 (없으면 추가)
3. 특수 캐시 리셋:
   - `ADMIN_USERS` → `resetAdminUsersCache()`
   - `CLAUDE_CODE_OAUTH_TOKEN_LIST` → `tokenManager.initialize()` 재호출
   - 기타 → process.env만 업데이트 (대부분의 코드가 직접 읽음)

### 5.7 Integration Points

| 기존 모듈 | 변경 내용 |
|----------|----------|
| `user-settings-store.ts` | `accepted` 필드 추가, 마이그레이션 로직 |
| `session-initializer.ts` | acceptance gate 추가 |
| `command-router.ts` | `AdminHandler` 등록 |
| `admin-utils.ts` | `resetAdminUsersCache()` export (이미 존재) |
| `src/slack/actions/` | Accept/Deny 버튼 action handler 추가 |
| `env-paths.ts` | ENV_FILE export (이미 존재) |

## 6. Non-Functional Requirements

- **Performance**: acceptance check는 in-memory (user-settings.json이 이미 메모리에 로드)
- **Security**: config 명령어는 admin-only, 시크릿 마스킹 필수
- **Reliability**: .env 파일 쓰기 실패 시 process.env는 이미 업데이트된 상태 → 경고 메시지 표시

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| `CommandHandler` 패턴 따름 | tiny | 기존 `CctHandler` 등과 동일한 패턴 |
| `isAdminUser()` 재활용 | tiny | 이미 검증된 admin 체크 로직 |
| `UserSettings`에 필드 추가 | small | 기존 스키마 확장, 마이그레이션 단순 |
| CCT는 기존 `CctHandler` 유지 | small | 이미 잘 동작하는 코드, 불필요한 이동 없음 |
| 시크릿 마스킹 패턴 자동 감지 | tiny | KEY 이름 기반 패턴 매칭 |
| acceptance gate를 SessionInitializer에 배치 | small | 가장 빠른 차단 지점, 기존 onboarding 분기 활용 |

## 8. Open Questions

None — 모든 결정 확정됨.

## 9. Next Step

→ `stv:trace` 로 Vertical Trace 진행
