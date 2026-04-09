# Session Archive Store — Spec

> STV Spec | Created: 2026-04-09

## 1. Overview

### Proposal
- **Why**: 세션 terminate 시 메타데이터가 완전 유실됨. `terminateSession()`이 Map에서 삭제 후 `saveSessions()`를 호출하므로 디스크에도 기록되지 않음. 작업 이력 추적, 대시보드 종료 표시, 사후 조회가 모두 불가능.
- **What Changes**: terminate/sleep-expire 직전에 세션 스냅샷을 아카이브 파일로 영구 저장. 대시보드 종료 컬럼이 아카이브에서 데이터를 읽음. CLI 스크립트로 과거 세션 조회.
- **Capabilities**: 세션 사후 조회, 종료 세션 대시보드 표시, 세션 이력 검색/필터링
- **Impact**: `session-registry.ts`, `dashboard.ts` 수정. 새 파일 `session-archive.ts`, `scripts/soma-cli.ts` 추가. BREAKING 없음.

세션의 전체 생명주기를 영구 기록하여, 종료 이후에도 메타데이터(model, links, mergeStats, usage, instructions)와 대화 이력을 함께 조회할 수 있게 한다. 대시보드 종료 컬럼에 최근 종료 세션을 표시하고, 일정 시간이 지나면 대시보드에서는 숨기되 CLI로는 영구 조회 가능하게 한다.

## 2. User Stories

- As a **팀 리더**, I want 종료된 세션의 작업 내역을 확인할 수 있다, so that 누가 무슨 작업을 했는지 추적할 수 있다.
- As a **유저**, I want 대시보드 종료 컬럼에서 최근 종료 세션을 볼 수 있다, so that 방금 끝난 세션을 다시 확인할 수 있다.
- As a **운영자**, I want CLI로 과거 세션을 검색할 수 있다, so that 특정 유저/기간/모델의 세션 이력을 조회할 수 있다.
- As a **유저**, I want 종료된 세션의 대화 내역을 볼 수 있다, so that 과거 작업 맥락을 복원할 수 있다.

## 3. Acceptance Criteria

- [ ] 세션 terminate 시 아카이브 파일에 전체 메타데이터 저장
- [ ] 세션 sleep-expire 시에도 아카이브 파일 저장
- [ ] 대시보드 종료(closed) 컬럼에 최근 48시간 내 아카이브 세션 표시
- [ ] 48시간 이후 대시보드에서 숨김 (아카이브 파일은 영구 보존)
- [ ] 아카이브에 conversationId 포함하여 대화 이력 연결 유지
- [ ] CLI로 아카이브 세션 목록 조회 (필터: 유저, 기간, 모델)
- [ ] CLI로 특정 아카이브 세션 상세 조회 (메타데이터 + 대화 요약)
- [ ] 기존 동작에 영향 없음 (terminate 후 메모리에서 삭제는 동일)

## 4. Scope

### In-Scope
- 아카이브 저장소 (SessionArchiveStore) 구현
- terminateSession() / cleanupInactiveSessions() 수정 — 삭제 전 아카이브
- 대시보드 buildKanbanBoard() 수정 — 아카이브에서 closed 데이터 읽기
- CLI 스크립트 (soma-cli) — 아카이브 조회/검색
- ArchivedSession 타입 정의

### Out-of-Scope
- 기존 sessions.json을 SQLite로 교체 (별도 작업)
- conversations/*.json 마이그레이션 (이미 영구 보존됨)
- 아카이브된 세션 복원(wake) 기능
- 웹 UI에서의 아카이브 조회 (대시보드 종료 컬럼만 지원)
- 아카이브 자동 정리(TTL) — 영구 보존

## 5. Architecture

### 5.1 Layer Structure

```
terminateSession() / cleanupInactiveSessions()
    │
    ├──→ SessionArchiveStore.archive(session, reason)  ← 새 레이어
    │       └── {DATA_DIR}/archives/{sessionKey}.json
    │
    ├──→ sessions.delete(sessionKey)   ← 기존 동작 유지
    └──→ saveSessions()                ← 기존 동작 유지

buildKanbanBoard()
    │
    ├──→ getAllSessions()              ← 기존: 활성 세션 (working/waiting/idle)
    └──→ SessionArchiveStore.listRecent(48h) ← 새: closed 컬럼 데이터
```

### 5.2 Data Flow

```
세션 생명주기:
  Create → MAIN(working/waiting/idle) → terminate → archive → delete from Map
                                      → 24h idle → SLEEPING → 7d → archive → delete

대시보드 데이터 소스:
  working/waiting/idle ← 메모리 Map (getAllSessions)
  closed              ← 아카이브 파일 (SessionArchiveStore.listRecent)
```

### 5.3 파일 구조

```
{DATA_DIR}/
├── sessions.json                        ← 기존 (활성 세션)
├── conversations/{id}.json              ← 기존 (대화 이력)
├── metrics-events-{date}.jsonl          ← 기존 (메트릭)
└── archives/                            ← 신규
    ├── C123-456.789.json                ← 아카이브된 세션 (sessionKey 기반)
    ├── C123-456.790.json
    └── ...
```

### 5.4 ArchivedSession 타입

```typescript
interface ArchivedSession {
  // Archive metadata
  archivedAt: number;           // Unix ms
  archiveReason: 'terminated' | 'sleep_expired';

  // Session identity
  sessionKey: string;
  sessionId?: string;
  conversationId?: string;      // → conversations/{id}.json 연결

  // Owner
  ownerId: string;
  ownerName?: string;

  // Session context
  channelId: string;
  threadTs?: string;
  title?: string;
  model?: string;
  workflow?: WorkflowType;

  // Timestamps
  createdAt: number;            // 세션 최초 생성 시점 (lastActivity 기반 추정)
  lastActivity: string;         // ISO date

  // Work artifacts
  links?: SessionLinks;
  linkHistory?: SessionLinkHistory;
  instructions?: SessionInstruction[];
  mergeStats?: {
    totalLinesAdded: number;
    totalLinesDeleted: number;
    mergedPRs: Array<{
      prNumber: number;
      linesAdded: number;
      linesDeleted: number;
      mergedAt: number;
    }>;
  };

  // Usage (tokens/cost snapshot at time of archive)
  usage?: SessionUsage;

  // State at time of archive
  finalState: SessionState;
  finalActivityState?: ActivityState;
}
```

### 5.5 SessionArchiveStore API

```typescript
class SessionArchiveStore {
  constructor(baseDir?: string)  // default: {DATA_DIR}/archives

  // 세션을 아카이브에 저장 (atomic write)
  archive(session: ConversationSession, sessionKey: string, reason: 'terminated' | 'sleep_expired'): void

  // 최근 N시간 내 아카이브 목록 (대시보드용)
  listRecent(maxAgeMs: number): ArchivedSession[]

  // 전체 아카이브 목록 (CLI용, 필터 지원)
  list(filter?: ArchiveFilter): ArchivedSession[]

  // 특정 아카이브 로드
  load(sessionKey: string): ArchivedSession | null

  // 아카이브 존재 확인
  exists(sessionKey: string): boolean
}

interface ArchiveFilter {
  ownerId?: string;
  model?: string;
  after?: number;    // Unix ms
  before?: number;   // Unix ms
  workflow?: string;
  limit?: number;
}
```

### 5.6 Integration Points

| 기존 코드 | 변경 내용 |
|-----------|----------|
| `session-registry.ts:terminateSession()` | archive() 호출 추가 (delete 전) |
| `session-registry.ts:cleanupInactiveSessions()` | sleep-expire 시 archive() 호출 추가 |
| `conversation/dashboard.ts:buildKanbanBoard()` | closed 컬럼에 listRecent() 데이터 추가 |
| `conversation/dashboard.ts:sessionToKanban()` | ArchivedSession → KanbanSession 변환 로직 추가 |

### 5.7 CLI 설계

```
scripts/soma-cli.ts — tsx로 실행

Usage:
  tsx scripts/soma-cli.ts sessions list [--user <id>] [--model <name>] [--since <date>] [--limit N]
  tsx scripts/soma-cli.ts sessions show <sessionKey>
  tsx scripts/soma-cli.ts sessions show <sessionKey> --conversation  (대화 이력 포함)

Output format: 터미널 테이블 (default) 또는 JSON (--json)
```

## 6. Non-Functional Requirements

- **Performance**: archive()는 동기 I/O (writeFileSync) 허용 — terminate은 드문 이벤트. listRecent()는 fs.readdirSync + stat 필터링으로 충분 (수천 파일까지 문제 없음)
- **Durability**: atomic write (tmp → rename) 패턴 사용 (conversations/와 동일)
- **Disk**: 아카이브 파일당 ~2-5KB. 1000세션 = ~5MB. 영구 보존해도 디스크 부담 없음
- **Compatibility**: 기존 sessions.json, conversations/ 동작에 영향 없음. 순수 추가(additive) 변경

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| 저장소: 개별 JSON 파일 | small | 의존성 제로, 기존 conversations/ 패턴과 동일, SQLite는 나중에 교체 가능 |
| 아카이브 트리거: terminate + sleep-expire 양쪽 | tiny | 두 경로 모두 세션이 사라지므로 당연히 양쪽에서 아카이브 |
| 대시보드 표시: 최근 48시간 | small | 24시간(활성 타임아웃)의 2배 — 종료 직후 확인 가능하되 오래된 건 숨김 |
| CLI: tsx 스크립트 | small | 별도 패키지 불필요, 개발 환경에서 바로 실행 가능 |
| 파일명: sessionKey 기반 | tiny | sessionKey가 이미 유니크 (channelId-threadTs) |
| 아카이브 영구 보존 | small | TTL 없음. 디스크 비용 무시할 수준. 필요 시 수동 정리 |

## 8. Open Questions

None — 모든 결정이 기존 패턴과 유저 의도에서 도출됨.

## 9. Spec Changelog

_(Initial creation)_

## 10. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/session-archive/spec.md`
