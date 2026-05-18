# Session Management Specification

## Version
- Document Version: 1.1
- Source File: `src/session-registry.ts`
- Last Updated: 2026-03-06

## 1. Overview

세션 관리 시스템은 Slack 대화와 Claude Code 세션을 연결하고, 컨텍스트를 유지하며, 다중 사용자 환경에서의 세션 공유를 처리합니다.

## 2. Session Model

### 2.1 ConversationSession Interface

```typescript
export interface ConversationSession {
  ownerId: string;              // 세션을 시작한 사용자 ID
  ownerName?: string;           // 소유자 표시 이름
  currentInitiatorId?: string;  // 현재 응답을 요청한 사용자
  currentInitiatorName?: string; // 현재 요청자 표시 이름
  channelId: string;            // Slack 채널 ID
  threadTs?: string;            // 스레드 타임스탬프 (스레드인 경우)
  sessionId?: string;           // Claude Code 세션 ID
  isActive: boolean;            // 활성 상태 플래그
  lastActivity: Date;           // 마지막 활동 시간
  workingDirectory?: string;    // 작업 디렉토리

  // 세션 만료 경고 추적
  warningMessageTs?: string;    // 경고 메시지 타임스탬프
  lastWarningSentAt?: number;   // 마지막으로 전송된 경고 시간 (ms)

  // 레거시 필드 (하위 호환성)
  userId: string;               // = ownerId
}
```

## 3. Session Key

### 3.1 Key Generation

세션 키는 채널과 스레드 기반으로 생성됩니다 (공유 세션):

```typescript
getSessionKey(channelId: string, threadTs?: string): string {
  return `${channelId}-${threadTs || 'direct'}`;
}
```

### 3.2 Key Examples

| Context | Key Format |
|---------|-----------|
| Channel direct | `C01ABC23DEF-direct` |
| Thread | `C01ABC23DEF-1234567890.123456` |
| DM direct | `D01ABC23DEF-direct` |
| DM thread | `D01ABC23DEF-1234567890.123456` |

### 3.3 Legacy Support

이전 버전과의 호환성을 위한 레거시 메서드:

```typescript
// userId 무시 (공유 세션)
getSessionKeyWithUser(userId: string, channelId: string, threadTs?: string): string {
  return this.getSessionKey(channelId, threadTs);
}
```

## 4. Session Lifecycle

### 4.1 Session Creation

```typescript
createSession(
  ownerId: string,
  ownerName: string,
  channelId: string,
  threadTs?: string
): ConversationSession {
  const session: ConversationSession = {
    ownerId,
    ownerName,
    userId: ownerId,  // 레거시 필드
    channelId,
    threadTs,
    isActive: true,
    lastActivity: new Date(),
  };

  this.sessions.set(this.getSessionKey(channelId, threadTs), session);
  return session;
}
```

### 4.2 Session Retrieval

```typescript
getSession(channelId: string, threadTs?: string): ConversationSession | undefined {
  return this.sessions.get(this.getSessionKey(channelId, threadTs));
}
```

### 4.3 Session ID Assignment

Claude SDK init 메시지에서 세션 ID 할당:

```typescript
if (message.type === 'system' && message.subtype === 'init') {
  session.sessionId = message.session_id;
}
```

### 4.4 Session Activity Update

```typescript
updateInitiator(
  channelId: string,
  threadTs: string | undefined,
  initiatorId: string,
  initiatorName: string
): void {
  const session = this.getSession(channelId, threadTs);
  if (session) {
    session.currentInitiatorId = initiatorId;
    session.currentInitiatorName = initiatorName;
    session.lastActivity = new Date();
  }
}
```

## 5. Session Ownership

### 5.1 Owner vs Initiator

- **Owner**: 세션을 처음 시작한 사용자
- **Initiator**: 현재 Claude에게 요청을 보낸 사용자

### 5.2 Interrupt Permission

```typescript
canInterrupt(
  channelId: string,
  threadTs: string | undefined,
  userId: string
): boolean {
  const session = this.getSession(channelId, threadTs);

  if (!session) return true;  // 세션 없으면 누구나 가능

  // 소유자는 항상 인터럽트 가능
  if (session.ownerId === userId) return true;

  // 현재 요청자도 인터럽트 가능
  if (session.currentInitiatorId === userId) return true;

  return false;
}
```

## 6. Session Expiry

### 6.1 Timeout Configuration

```typescript
const DEFAULT_SESSION_TIMEOUT = 24 * 60 * 60 * 1000;  // 24시간
```

### 6.2 Warning Intervals

```typescript
const WARNING_INTERVALS = [
  10 * 60 * 1000,  // 만료 10분 전
];
```

### 6.3 Cleanup Process

```typescript
async cleanupInactiveSessions(maxAge: number = DEFAULT_SESSION_TIMEOUT) {
  const now = Date.now();

  for (const [key, session] of this.sessions.entries()) {
    const sessionAge = now - session.lastActivity.getTime();
    const timeUntilExpiry = maxAge - sessionAge;

    // 만료된 세션 처리
    if (timeUntilExpiry <= 0) {
      if (this.expiryCallbacks) {
        await this.expiryCallbacks.onExpiry(session);
      }
      this.sessions.delete(key);
      continue;
    }

    // 경고 전송 체크
    if (this.expiryCallbacks) {
      for (const warningInterval of WARNING_INTERVALS) {
        if (timeUntilExpiry <= warningInterval) {
          const lastWarningSent = session.lastWarningSentAt || Infinity;

          if (warningInterval < lastWarningSent) {
            const newMessageTs = await this.expiryCallbacks.onWarning(
              session,
              timeUntilExpiry,
              session.warningMessageTs
            );

            session.lastWarningSentAt = warningInterval;
            if (newMessageTs) {
              session.warningMessageTs = newMessageTs;
            }
          }
          break;
        }
      }
    }
  }
}
```

### 6.4 Periodic Cleanup

```typescript
// 5분마다 정리 실행
setInterval(async () => {
  await this.claudeHandler.cleanupInactiveSessions();
}, 5 * 60 * 1000);
```

## 7. Session Expiry Callbacks

### 7.1 Callback Interface

```typescript
export interface SessionExpiryCallbacks {
  onWarning: (
    session: ConversationSession,
    timeRemaining: number,
    warningMessageTs?: string
  ) => Promise<string | undefined>;

  onExpiry: (session: ConversationSession) => Promise<void>;
}
```

### 7.2 Warning Message

```typescript
private async handleSessionWarning(
  session: ConversationSession,
  timeRemaining: number,
  existingMessageTs?: string
): Promise<string | undefined> {
  const warningText = `⚠️ *세션 만료 예정*\n\n이 세션은 *${this.formatTimeRemaining(timeRemaining)}* 후에 만료됩니다.\n세션을 유지하려면 메시지를 보내주세요.`;

  if (existingMessageTs) {
    // 기존 경고 메시지 업데이트
    await this.app.client.chat.update({ ... });
    return existingMessageTs;
  } else {
    // 새 경고 메시지 생성
    const result = await this.app.client.chat.postMessage({ ... });
    return result.ts;
  }
}
```

### 7.3 Expiry Message

```typescript
private async handleSessionExpiry(session: ConversationSession): Promise<void> {
  const expiryText = `🔒 *세션이 종료되었습니다*\n\n24시간 동안 활동이 없어 이 세션이 종료되었습니다.\n새로운 대화를 시작하려면 다시 메시지를 보내주세요.`;

  if (session.warningMessageTs) {
    await this.app.client.chat.update({ ... });
  } else {
    await this.app.client.chat.postMessage({ ... });
  }
}
```

## 8. Session Persistence

### 8.1 Storage File

```typescript
const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
```

### 8.2 Serialized Format

```typescript
interface SerializedSession {
  key: string;
  ownerId: string;
  ownerName?: string;
  userId: string;           // 레거시
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: string;     // ISO 날짜 문자열
  workingDirectory?: string;
}
```

### 8.3 Save Sessions

```typescript
saveSessions(): void {
  const sessionsArray: SerializedSession[] = [];

  for (const [key, session] of this.sessions.entries()) {
    // sessionId가 있는 세션만 저장 (대화 기록 있음)
    if (session.sessionId) {
      sessionsArray.push({
        key,
        ownerId: session.ownerId,
        ownerName: session.ownerName,
        userId: session.userId,
        channelId: session.channelId,
        threadTs: session.threadTs,
        sessionId: session.sessionId,
        isActive: session.isActive,
        lastActivity: session.lastActivity.toISOString(),
        workingDirectory: session.workingDirectory,
      });
    }
  }

  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsArray, null, 2));
}
```

### 8.4 Load Sessions

```typescript
loadSessions(): number {
  if (!fs.existsSync(SESSIONS_FILE)) {
    return 0;
  }

  const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
  const sessionsArray: SerializedSession[] = JSON.parse(data);

  let loaded = 0;
  const now = Date.now();
  const maxAge = DEFAULT_SESSION_TIMEOUT;

  for (const serialized of sessionsArray) {
    const lastActivity = new Date(serialized.lastActivity);
    const sessionAge = now - lastActivity.getTime();

    // 만료되지 않은 세션만 복원
    if (sessionAge < maxAge) {
      const session: ConversationSession = {
        ownerId: serialized.ownerId || serialized.userId,
        ownerName: serialized.ownerName,
        userId: serialized.userId,
        channelId: serialized.channelId,
        threadTs: serialized.threadTs,
        sessionId: serialized.sessionId,
        isActive: serialized.isActive,
        lastActivity,
        workingDirectory: serialized.workingDirectory,
      };

      this.sessions.set(serialized.key, session);
      loaded++;
    }
  }

  return loaded;
}
```

## 9. Shutdown Handling

### 9.1 Shutdown Notification

```typescript
async notifyShutdown(): Promise<void> {
  const shutdownText = `🔄 *서버 재시작 중*\n\n서버가 재시작됩니다. 잠시 후 다시 대화를 이어갈 수 있습니다.\n세션이 저장되었으므로 서버 재시작 후에도 대화 내용이 유지됩니다.`;

  for (const [key, session] of this.sessions.entries()) {
    if (session.sessionId) {
      await this.app.client.chat.postMessage({
        channel: session.channelId,
        text: shutdownText,
        thread_ts: session.threadTs,
      });
    }
  }
}
```

### 9.2 Graceful Shutdown

```typescript
const cleanup = async () => {
  await slackHandler.notifyShutdown();
  slackHandler.saveSessions();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
```

## 10. Session Commands

### 10.1 List User Sessions

```
sessions
/sessions
```

**출력 예시**:
```
📋 *내 세션 목록* (2개)

*1. #channel-name* (thread)
   📁 `/path/to/project`
   🕐 마지막 활동: 5분 전 | 🎯 현재 대화: 다른사용자
   ⏳ 만료: 23시간 55분 남음

*2. DM*
   📁 `/path/to/other`
   🕐 마지막 활동: 1시간 전
   ⏳ 만료: 22시간 남음
```

### 10.2 List All Sessions

```
all_sessions
/all_sessions
```

**출력 예시**:
```
🌐 *전체 세션 현황* (5개)

👤 *홍길동* (2개 세션)
   • #backend (thread) | 📁 `project-a` | 🕐 5분 전 | ⏳ 23시간 남음
   • DM | 📁 `project-b` | 🕐 1시간 전 | ⏳ 22시간 남음

👤 *김철수* (3개 세션)
   • #frontend | 📁 `webapp` | 🕐 30분 전 | 🎯 박영희 | ⏳ 23시간 30분 남음
   ...
```

## 11. Session Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    User Message                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│             Check Existing Session                           │
│         getSession(channelId, threadTs)                     │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│   No Session         │        │   Session Exists     │
│   createSession()    │        │   updateInitiator()  │
└──────────────────────┘        └──────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Claude Query                              │
│             options.resume = session.sessionId              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Session ID Assignment                       │
│        session.sessionId = message.session_id               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Activity Updated                            │
│            session.lastActivity = new Date()                │
└─────────────────────────────────────────────────────────────┘
```
