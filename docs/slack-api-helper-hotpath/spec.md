# SlackApiHelper Hot Path Integration — Spec

> STV Spec | Created: 2026-03-06

## 1. Overview

현재 Slack rate limit 병목은 로컬 서버 성능이 아니라 **핫패스 메시지 업데이트가 `SlackApiHelper`의 큐와 `Retry-After` 처리 밖에서 직접 실행되는 구조**에서 발생한다. `StatusReporter`, `TodoDisplayManager`, `StreamExecutor`의 compact tool update 경로가 공용 helper를 우회하면서, 동일 세션 안의 update burst가 토큰 버킷 제어 없이 Slack `chat.update`로 바로 전송된다.

이 작업은 새 throttling 정책이나 coalescing을 도입하지 않는다. 먼저 **기존에 이미 있는 `SlackApiHelper`를 모든 핫패스 메시지 수정 경로의 단일 진입점으로 강제**해서, 현재 재현된 429 누적 원인을 줄이는 데 집중한다.

## 2. User Stories

- As a Slack 사용자, I want 진행 상태 메시지가 과도한 `chat.update` 없이 안정적으로 보이기를, so that 응답 지연이 줄어든다.
- As a 운영자, I want 핫패스 Slack API 호출이 하나의 큐와 retry 정책을 공유하기를, so that rate limit이 누적되어 전체 응답이 느려지지 않는다.
- As a 개발자, I want 고빈도 메시지 수정 경로가 모두 같은 helper를 사용하기를, so that rate limit 제어를 한 곳에서 유지할 수 있다.

## 3. Acceptance Criteria

- [ ] `StatusReporter.createStatusMessage()`가 직접 `chat.postMessage()`를 호출하지 않고 공유 `SlackApiHelper.postMessage()`를 사용한다.
- [ ] `StatusReporter.updateStatus()`와 `updateStatusDirect()`가 공유 `SlackApiHelper.updateMessage()`를 사용한다.
- [ ] `TodoDisplayManager`의 기존 todo 메시지 수정이 직접 `chat.update()`를 호출하지 않고 공유 `SlackApiHelper.updateMessage()`를 사용한다.
- [ ] todo 업데이트 실패 시 기존 fallback 동작인 `createNewMessage()` 재생성은 유지된다.
- [ ] `StreamExecutor`의 compact tool-call message 갱신이 `getClient().chat.update()`를 우회하지 않고 공유 `SlackApiHelper.updateMessage()`를 사용한다.
- [ ] `SlackHandler`가 이미 생성한 단일 `SlackApiHelper` 인스턴스를 `StatusReporter`와 `TodoDisplayManager`에도 주입한다.
- [ ] 회귀 테스트가 helper 사용 경로와 fallback 경로를 검증한다.

## 4. Scope

### In-Scope

- `src/slack/status-reporter.ts`
- `src/slack/todo-display-manager.ts`
- `src/slack/pipeline/stream-executor.ts`
- `src/slack-handler.ts`의 의존성 주입 wiring
- 위 세 경로를 검증하는 Vitest 회귀 테스트

### Out-of-Scope

- status/todo/tool 진행 메시지 coalescing
- dispatch short-circuiting
- Claude limit 감지 후 즉시 반환 UX
- 저빈도 direct WebClient 사용 모듈(`CredentialAlert`, `ChannelRegistry`, `ReleaseNotifier`, permission messenger) 정리
- `SlackApiHelper`의 rate-limit 알고리즘 자체 변경

## 5. Architecture

### 5.1 Current Problem

`SlackHandler`는 이미 앱 단위 `SlackApiHelper`를 하나 생성한다. 하지만 아래 핫패스는 그 인스턴스를 사용하지 않는다.

| Path | Current behavior | Risk |
|------|------------------|------|
| `StatusReporter` | `WebClient.chat.postMessage/update` 직접 호출 | 요청 시작/상태 전환 때 queue bypass |
| `TodoDisplayManager` | `WebClient.chat.update` 직접 호출 | todo burst가 helper queue bypass |
| `StreamExecutor.onUpdateMessage` | `slackApi.getClient().chat.update` 직접 호출 | compact tool result update가 helper queue bypass |

### 5.2 Target Structure

모든 핫패스 메시지 수정은 `SlackApiHelper`만 사용한다.

```text
SlackHandler
  └─ SlackApiHelper (single shared instance)
      ├─ StatusReporter
      ├─ TodoDisplayManager
      └─ StreamExecutor.onUpdateMessage
```

### 5.3 Integration Points

| Existing code | Change |
|---------------|--------|
| `new StatusReporter(app.client)` | `new StatusReporter(this.slackApi)` |
| `new TodoDisplayManager(app.client, ...)` | `new TodoDisplayManager(this.slackApi, ...)` |
| `slackApi.getClient().chat.update(...)` | `slackApi.updateMessage(...)` |

### 5.4 Error Handling Strategy

- `StatusReporter`는 helper 오류를 기존처럼 로깅하고 삼킨다.
- `TodoDisplayManager`는 helper update 실패 시 기존처럼 새 메시지를 생성한다.
- `StreamExecutor`는 compact update 실패 시 기존처럼 debug 로그만 남기고 스트림 진행을 유지한다.

## 6. Non-Functional Requirements

- **Rate-limit safety**: 핫패스 message post/update는 helper queue와 `Retry-After` 재시도 정책을 반드시 통과한다.
- **Behavior stability**: 사용자에게 보이는 상태 메시지 텍스트와 fallback 동작은 바뀌지 않는다.
- **Observability**: 기존 logger 레벨과 메시지 의미는 유지한다.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 공유 helper 인스턴스 재사용, 새 singleton/global 도입 안함 | small | `SlackHandler`가 이미 lifecycle을 소유하고 있어 주입만 바꾸면 된다 |
| todo 신규 메시지 생성은 `say()` 경로 유지 | small | 이번 병목은 수정(update) 폭주가 핵심이며, 신규 생성 흐름 변경은 범위를 넓힌다 |
| 저빈도 direct WebClient 모듈은 제외 | small | 유저가 제시한 우선순위와 핫패스 로그 근거상 먼저 다룰 대상이 아니다 |
| coalescing은 별도 작업으로 분리 | small | helper 통합만으로도 명확한 원인 하나를 제거할 수 있다 |

## 8. Open Questions

None — 현재 작업은 기존 helper 사용 강제에 한정되어 있고, medium 이상의 아키텍처 변경은 범위 밖으로 분리했다.

## 9. Next Step

→ `docs/slack-api-helper-hotpath/trace.md`에 시나리오를 세분화하고 RED 테스트를 만든다.
