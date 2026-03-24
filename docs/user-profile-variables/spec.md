# User Profile Variable System — Spec

> STV Spec | Created: 2026-03-24 | Issue: #61 | PR: #62
> Status: Retroactive (implementation complete, spec created from code)

## 1. Overview

워크플로우 `.prompt` 파일에서 `{{user.email}}`, `{{user.displayName}}` 등의 변수를 **확정적으로 치환**하여, 커밋/PR 생성 시 요청자 attribution이 자동 포함되도록 한다. Slack 프로필에서 이메일을 자동 수집하고 UserSettings에 캐시하여, PromptBuilder가 시스템 프롬프트 빌드 시 변수를 치환한다.

## 2. User Stories

- As a **개발자**, I want 내 커밋에 Co-Authored-By가 자동으로 포함되길 원한다, so that 누가 요청한 작업인지 git log로 추적할 수 있다.
- As a **팀 리더**, I want 모든 AI-generated 커밋에 요청자 정보가 남길 원한다, so that attribution과 감사 추적이 가능하다.
- As a **시스템**, I want 이메일을 한 번만 Slack API로 가져오고 캐시하길 원한다, so that 불필요한 API 호출을 줄인다.

## 3. Acceptance Criteria

- [x] `{{user.email}}` → Slack 프로필 이메일로 치환
- [x] `{{user.displayName}}` → Slack 표시 이름으로 치환
- [x] `{{user.slackId}}` → Slack 유저 ID로 치환
- [x] `{{user.jiraName}}` → Jira 표시 이름으로 치환
- [x] 미등록 유저의 변수는 `{{user.email}}` 형태 그대로 유지 (fallback)
- [x] 세션 시작 시 이메일 자동 fetch, UserSettings에 캐시
- [x] `users:read.email` scope 없을 때 graceful degradation (empty sentinel)
- [x] jira-create-pr 워크플로우 3곳에 Co-Authored-By 포함
- [x] pr-fix-and-update 워크플로우에 Co-Authored-By 포함
- [x] **단위 테스트**: processVariables user 변수 치환 검증
- [x] **단위 테스트**: getUserProfile Slack API mock 검증
- [x] **단위 테스트**: UserSettings email getter/setter 검증
- [x] `\{{...}}` 이스케이프 — common.prompt 문서 변수가 치환되지 않도록

## 4. Scope

### In-Scope
- UserSettings `email` 필드 추가 + getter/setter
- SlackApiHelper `getUserProfile()` 메서드
- StreamExecutor 세션 시작 시 email auto-fetch
- PromptBuilder dot notation 변수 패턴 + `resolveUserVariable()`
- 워크플로우 프롬프트 Co-Authored-By 템플릿
- common.prompt 변수 문서 + fallback 지시

### Out-of-Scope
- Slack App OAuth scope 자동 설정
- 이메일 수동 입력 UI
- 다른 워크플로우 프롬프트 수정 (jira-create-pr, pr-fix-and-update 외)
- GitHub commit author 자동 설정 (Git config)

## 5. Architecture

### 5.1 Data Flow

```
Slack User sends message
    ↓
StreamExecutor.execute()
    ↓
[Check] getUserEmail(userId) cached?
    ├─ Yes → skip
    └─ No → SlackApiHelper.getUserProfile(userId)
              ↓
           [Store] setUserEmail(userId, email)
    ↓
ClaudeHandler.query() → PromptBuilder.buildSystemPrompt(userId, workflow)
    ↓
processVariables(content, userId)
    ↓
resolveUserVariable("user.email", userId) → UserSettings.email
    ↓
Resolved prompt with Co-Authored-By: Name <email>
```

### 5.2 Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| UserSettingsStore | `src/user-settings-store.ts` | email 영속 저장/조회 |
| SlackApiHelper | `src/slack/slack-api-helper.ts` | Slack API로 프로필 조회 |
| StreamExecutor | `src/slack/pipeline/stream-executor.ts` | 세션 시작 시 email auto-fetch trigger |
| PromptBuilder | `src/prompt-builder.ts` | 변수 패턴 매칭 + 치환 엔진 |
| Workflow Prompts | `src/prompt/workflows/*.prompt` | Co-Authored-By 템플릿 |

### 5.3 Variable Resolution

| Variable | Source | Fallback |
|----------|--------|----------|
| `{{user.email}}` | `UserSettings.email` | 미치환 (원본 유지) |
| `{{user.displayName}}` | `UserSettings.slackName` | 미치환 |
| `{{user.slackId}}` | `UserSettings.userId` | 미치환 |
| `{{user.jiraName}}` | `UserSettings.jiraName` | 미치환 |

### 5.4 Integration Points

- **PromptBuilder ↔ UserSettingsStore**: `resolveUserVariable()`에서 직접 import
- **StreamExecutor ↔ SlackApiHelper**: `getUserProfile()` 호출
- **StreamExecutor ↔ UserSettingsStore**: `getUserEmail()` / `setUserEmail()`
- **ClaudeHandler → PromptBuilder**: `buildSystemPrompt(userId, workflow)` — userId 이미 전달됨

## 6. Non-Functional Requirements

- **Performance**: email은 유저당 1회만 fetch, 이후 캐시 사용. 세션 시작의 critical path에 있으나 non-blocking (catch로 감싼 fire-and-forget 아님, await하지만 실패 시 skip)
- **Security**: 이메일은 UserSettings JSON에 평문 저장. 민감 데이터로 취급되나, 기존 UserSettings와 동일한 보안 수준.
- **Reliability**: Slack API 실패 시 email 없이 진행. 미치환 변수는 prompt에 fallback 지시로 처리.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| email을 UserSettings에 저장 | tiny | 기존 패턴(jiraName, slackName)과 동일 |
| VARIABLE_PATTERN을 `[\w.]`으로 확장 + `\{{` 이스케이프 | tiny | 기존 `\w`에 dot 추가 + negative lookbehind으로 이스케이프 지원 |
| processVariables에 userId 파라미터 추가 | small | 시그니처 변경이나 호출부 1곳만 수정 |
| resolveUserVariable을 switch문으로 구현 | tiny | 변수 4개, 단순 매핑 |
| auto-fetch를 StreamExecutor에 배치 | small | 세션 시작의 자연스러운 위치, 기존 패턴 |
| fallback을 "미치환 유지 + prompt 지시"로 처리 | small | 코드 변경 최소화, LLM이 판단 |
| empty sentinel로 반복 fetch 방지 | tiny | `=== undefined` 체크 + `email ?? ''` 저장 |

## 8. Resolved Questions

- **테스트 부재**: ✅ 해결됨 — prompt-builder.test.ts (23건), user-settings-store.test.ts (5건), slack-api-helper.test.ts (4건) 추가
- **displayName 매핑**: ✅ 해결됨 — StreamExecutor에서 `ensureUserExists(user, profile.displayName)` 호출하여 slackName에 저장
- **common.prompt 변수 자기 치환**: ✅ 해결됨 — `\{{...}}` 이스케이프 메커니즘 도입
- **반복 API 호출**: ✅ 해결됨 — empty sentinel (`''`) 저장 + `=== undefined` 체크
