# Turn Completion Notification System — Spec

> STV Spec | Created: 2026-03-24 | GitHub Issue: [#69](https://github.com/2lab-ai/soma-work/issues/69)

## 1. Overview

AI 턴이 종료되어 유저 입력을 대기할 때, 현재는 상태 전환이 눈에 띄지 않아 유저가 자신의 차례임을 인지하지 못한다. 이 기능은 턴 종료 시점에 **카테고리별 시각적 알림**(Slack Block Kit), **웹훅 POST**, **텔레그램 DM**을 통해 유저에게 즉각적 알림을 제공한다.

## 2. User Stories

- As a **soma-work 유저**, I want AI 턴 종료 시 Slack DM으로 눈에 띄는 알림을 받고 싶다, so that 내 차례가 왔음을 바로 인지하고 대응할 수 있다.
- As a **soma-work 유저**, I want 웹훅 URL을 등록하여 턴 종료 이벤트를 외부 시스템으로 받고 싶다, so that 자체 자동화 파이프라인에 연동할 수 있다.
- As a **soma-work 유저**, I want 텔레그램으로 턴 종료 DM을 받고 싶다, so that Slack을 보고 있지 않을 때도 알림을 받을 수 있다.
- As a **관리자**, I want Exception 발생 시 빨간색 긴급 알림을 받고 싶다, so that 서버 장애를 즉시 인지할 수 있다.

## 3. Acceptance Criteria

- [ ] 턴 종료 시 3가지 카테고리(UIUserAskQuestion🟠, WorkflowComplete🟢, Exception🔴)로 분류된다
- [ ] 각 카테고리에 맞는 Slack Block Kit 컬러 메시지가 스레드에 게시된다
- [ ] `notify on` 명령으로 Slack DM 알림을 활성화할 수 있다
- [ ] `webhook register <url>` 명령으로 웹훅을 등록할 수 있다
- [ ] 웹훅은 retry 3회, exponential backoff로 전송된다
- [ ] `notify telegram <chat_id>` 명령으로 텔레그램 알림을 등록할 수 있다
- [ ] 텔레그램 Bot API를 통해 턴 종료 DM이 전송된다
- [ ] 모든 알림은 fire-and-forget (비차단)으로 동작한다
- [ ] 알림 실패가 메인 세션 흐름에 영향을 주지 않는다

## 4. Scope

### In-Scope
- 턴 종료 카테고리 판별 로직
- Slack Block Kit 카테고리별 시각적 알림 (스레드 내)
- Slack DM 알림 (선택적)
- 웹훅 등록/삭제/발송 (retry + backoff)
- 텔레그램 Bot API DM 발송
- `notify`, `webhook` 커맨드 파싱
- UserSettings 확장 (알림 설정 저장)

### Out-of-Scope
- 카카오톡 연동 (API 제약으로 별도 조사 후 판단)
- GIF/이미지 에셋 (Phase 2에서 고려)
- 알림 스케줄링 (무음 시간대 등)
- 알림 히스토리/로깅 대시보드

## 5. Architecture

### 5.1 Layer Structure

```
커맨드 입력                              턴 종료 이벤트
    │                                        │
    ▼                                        ▼
CommandParser                        StreamExecutor.execute()
    │                                        │
    ▼                                        ▼
CommandRouter                         TurnNotifier.notify()
    │                                        │
    ▼                                        ├─→ SlackNotificationChannel
NotifyHandler ─→ UserSettingsStore    │     (Block Kit + DM)
WebhookHandler ─→ UserSettingsStore   ├─→ WebhookNotificationChannel
                                      │     (HTTP POST + retry)
                                      └─→ TelegramNotificationChannel
                                            (Bot API DM)
```

### 5.2 Turn Completion Categories

| 카테고리 | ActivityState | 트리거 조건 | 색상 |
|---------|---------------|------------|------|
| `UIUserAskQuestion` | `waiting` | `hasPendingChoice === true` | 🟠 `#FF9500` |
| `WorkflowComplete` | `idle` | `hasPendingChoice === false` | 🟢 `#36B37E` |
| `Exception` | (error path) | catch block에서 에러 발생 | 🔴 `#FF5630` |

### 5.3 Data Model (UserSettings 확장)

```typescript
// UserSettings interface에 추가
interface UserSettings {
  // ... existing fields ...

  // Notification preferences
  notification?: {
    slackDm?: boolean;           // Slack DM 알림 on/off (default: false)
    webhookUrl?: string;         // 등록된 웹훅 URL (null = 미등록)
    telegramChatId?: string;     // 텔레그램 chat ID (null = 미등록)
    categories?: {               // 카테고리별 on/off (default: all true)
      userAskQuestion?: boolean;
      workflowComplete?: boolean;
      exception?: boolean;
    };
  };
}
```

### 5.4 Command Interface

```
notify on                        → Slack DM 알림 활성화
notify off                       → Slack DM 알림 비활성화
notify status                    → 현재 알림 설정 조회
notify telegram <chat_id>        → 텔레그램 chat ID 등록
notify telegram off              → 텔레그램 알림 해제
webhook register <url>           → 웹훅 URL 등록
webhook remove                   → 웹훅 URL 삭제
webhook test                     → 테스트 페이로드 전송
```

### 5.5 Webhook Payload

```json
{
  "event": "turn_completed",
  "category": "UIUserAskQuestion",
  "sessionId": "C123-1234567890.123456",
  "userId": "U094E5L4A15",
  "channel": "C123",
  "threadTs": "1234567890.123456",
  "message": "어떤 방식으로 진행할까요?",
  "timestamp": "2026-03-24T10:54:41.406Z"
}
```

### 5.6 Integration Points

| 통합 대상 | 파일 | 변경 내용 |
|----------|------|----------|
| StreamExecutor | `src/slack/pipeline/stream-executor.ts` | L537 직후 `TurnNotifier.notify()` 호출 |
| CommandParser | `src/slack/command-parser.ts` | `notify`, `webhook` 키워드 + 파싱 메서드 |
| CommandRouter | `src/slack/commands/command-router.ts` | NotifyHandler, WebhookHandler 등록 |
| UserSettingsStore | `src/user-settings-store.ts` | `notification` 필드 + getter/setter |
| SlackApiHelper | `src/slack/slack-api-helper.ts` | `openDmChannel()` 메서드 추가 |

### 5.7 TurnNotifier Service

```typescript
interface TurnCompletionEvent {
  category: 'UIUserAskQuestion' | 'WorkflowComplete' | 'Exception';
  userId: string;
  channel: string;
  threadTs: string;
  sessionTitle?: string;
  message?: string;
  durationMs: number;
}

interface NotificationChannel {
  name: string;
  isEnabled(userId: string): Promise<boolean>;
  send(event: TurnCompletionEvent): Promise<void>;
}

class TurnNotifier {
  private channels: NotificationChannel[];

  async notify(event: TurnCompletionEvent): Promise<void> {
    // 모든 채널에 병렬로 fire-and-forget
    await Promise.allSettled(
      this.channels
        .filter(ch => ch.isEnabled(event.userId))
        .map(ch => ch.send(event))
    );
  }
}
```

### 5.8 Retry Strategy (Webhook)

```
attempt 1: 즉시
attempt 2: 1초 후
attempt 3: 4초 후  (exponential: 1s * 2^(n-1))
실패 시: warn 로그, 다음 이벤트에서 재시도
```

## 6. Non-Functional Requirements

- **Performance**: 알림은 fire-and-forget — 메인 스트림 처리에 지연을 주지 않는다
- **Reliability**: 알림 실패가 세션에 영향 없음. 웹훅은 3회 retry
- **Security**: 웹훅 URL은 HTTPS 권장, 텔레그램 봇 토큰은 환경변수로 관리
- **Scalability**: 채널별 독립 구현으로 새 채널 추가 시 NotificationChannel 구현만 추가

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| UserSettings에 notification 필드 추가 | small | 기존 jiraAccountId 등과 동일 패턴. 별도 파일 불필요 |
| CommandHandler 패턴 따름 | tiny | 20개 이상의 기존 핸들러와 동일 구조 |
| 훅 포인트: StreamExecutor L537 직후 | small | ActivityState 전환 직후가 유일한 정확한 시점 |
| TurnNotifier → NotificationChannel 전략 패턴 | small | 3개 채널(Slack/Webhook/Telegram) 독립 확장 가능 |
| 텔레그램: 조직 단일 봇, 유저는 chat ID만 등록 | small | 봇 토큰은 환경변수 1개, 유저별 토큰 관리 불필요 |
| 카카오톡 Phase 1 제외 | small | 개인 DM API 부재. 알림톡은 비즈니스 채널+심사 필요 |
| Slack DM은 `conversations.open` → `postMessage` | tiny | Slack API 표준 패턴 |
| 웹훅 retry: 3회, exponential backoff (1s base) | small | 업계 표준. 과도한 retry는 부하만 증가 |

## 8. Open Questions

None — 이슈 명세와 코드베이스 분석으로 모든 결정이 커버됨.
카카오톡 연동은 별도 이슈로 분리하여 API 가용성 조사 후 판단.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/turn-notification/spec.md`
