# PRD — soma-work Dashboard & Conversation System

> Reverse-engineered from implementation (PR #192, #271, #280, #283, #284, #297) + codebase analysis.
> Status legend: **[LIVE]** 프로덕션 동작 중 | **[WIRED]** 코드 존재, 핸들러 연결 필요 | **[PARTIAL]** 일부 구현 | **[PLANNED]** 시도/설계만 존재

---

## 1. Product Vision

soma-work의 모든 AI 세션을 실시간으로 모니터링하고 제어할 수 있는 **웹 기반 Kanban 대시보드**. Slack 외부에서 세션 상태를 한눈에 파악하고, 직접 명령을 보내거나 세션을 종료할 수 있다. 동시에 **대화 이력 시스템**이 모든 세션의 user↔assistant 턴을 기록하고, 요약 생성 후 웹에서 열람할 수 있게 한다.

**핵심 사용자**: soma-work 운영자, 개발팀 리더, 개별 개발자
**핵심 가치**: 세션 가시성(visibility), 실시간 제어(control), 이력 추적(traceability)

---

## 2. System Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────┐
│   Browser    │────▶│  Fastify Web Server (web-server.ts)      │
│  Dashboard   │◀───│  ├── /login           (oauth.ts)         │
│  + WebSocket │    │  ├── /dashboard        (dashboard.ts)     │
│              │    │  ├── /api/dashboard/*   (dashboard.ts)     │
│              │    │  ├── /conversations     (viewer.ts)        │
│              │    │  ├── /api/conversations (web-server.ts)    │
│              │    │  └── /ws               (WebSocket)         │
└─────────────┘     └──────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
  │ SessionStore │   │ Conversation │   │ MetricsEventStore│
  │ (in-memory)  │   │   Storage    │   │   (JSON files)   │
  │              │   │ (JSON files) │   │                  │
  └──────────────┘   └──────────────┘   └──────────────────┘
```

**핵심 파일 구조** (`src/conversation/`):
- `dashboard.ts` (67KB) — Kanban 대시보드 전체: 데이터 변환, API 라우트, HTML 렌더링, WebSocket
- `oauth.ts` (17KB) — Google/Microsoft OAuth2 + JWT 쿠키 인증
- `viewer.ts` (12KB) — 대화 이력 HTML 뷰어
- `web-server.ts` (11KB) — Fastify 서버, 라우팅 통합, 대화 이력 API
- `recorder.ts` (9KB) — 대화 턴 기록 + 인메모리 캐시 + 디스크 영속화
- `storage.ts` (4KB) — JSON 파일 기반 대화 저장소
- `summarizer.ts` (3KB) — Claude API로 assistant 턴 자동 요약 (제목 + 3줄 요약)
- `types.ts` (1.5KB) — ConversationTurn, ConversationRecord, ConversationMeta 타입

---

## 3. Feature Inventory

### 3.1 Kanban Dashboard (`/dashboard`) **[LIVE]**

4열 Kanban 보드로 모든 AI 세션의 실시간 상태를 표시한다.

**컬럼 구조**:
- **진행(Working)**: `activityState === 'working'` — AI가 현재 작업 중인 세션
- **유저입력(User Input)**: `activityState === 'waiting'` — 사용자 입력을 기다리는 세션
- **대기(Idle)**: 나머지 활성 세션
- **종료(Closed)**: `terminated === true` 또는 `state === 'SLEEPING'`

**카드 정보** (KanbanSession):
- 세션 제목, 소유자명, 워크플로우 유형, 모델명
- Issue/PR 링크 (라벨 + 제목 + 상태)
- 토큰 사용량 (input/output tokens, USD 비용, 컨텍스트 사용률 %)
- 머지 통계 (추가/삭제 라인 수)
- 마지막 활동 시간 (상대 표시: "3분 전")

**Aura System** (시간 기반 카드 테두리 글로우):
- ≤10분: Legendary (주황 + 금색 펄스)
- ≤30분: Epic (보라)
- ≤1시간: Blue
- ≤4시간: Green
- ≤8시간: White
- \>8시간: 글로우 없음

**종료 컬럼 7일 필터**: 7일 이내 종료 세션만 기본 표시, "Show older" 토글로 전체 보기.

**사용자 필터**: URL 경로 `/dashboard/:userId`로 특정 사용자 세션만 표시. 드롭다운 네비게이션.

### 3.2 Session Actions **[WIRED — 핸들러 연결 필요]**

카드에서 직접 세션을 제어하는 버튼.

| 액션 | API | 동작 |
|------|-----|------|
| ⏹ Stop | `POST /api/dashboard/session/:key/stop` | 작업 중인 세션 중단 |
| ✕ Close | `POST /api/dashboard/session/:key/close` | 세션 종료/terminate |
| 🗑 Trash | `POST /api/dashboard/session/:key/trash` | 종료된 세션 대시보드에서 숨김 |
| 💬 Command | `POST /api/dashboard/session/:key/command` | 세션에 메시지 전송 (Slack 스레드 대체) |

> **참고**: 백엔드 API와 프론트엔드 UI는 구현되어 있으나, 실제 `_stopHandlerFn`, `_closeHandlerFn` 등은 `index.ts`에서 `setDashboardStopHandler()` 등으로 연결해야 동작한다. PR #271 기준 핸들러 와이어링은 TODO 상태.

### 3.3 Task List on Cards **[LIVE]**

세션의 TodoWrite 태스크를 카드에 실시간 표시.
- ✅ completed, 🔄 in_progress, ⬜ pending 아이콘
- `setDashboardTaskAccessor()` + `broadcastTaskUpdate()`로 실시간 업데이트

### 3.4 Slide Panel (Session Detail) **[LIVE]**

카드 클릭 시 우측에서 슬라이드 패널이 열림.
- 세션 메타데이터 (제목, 소유자, 워크플로우, 생성/수정 시간)
- Issue/PR 링크
- 대화 턴 목록 (user 메시지 원문 + assistant 턴 요약)
- 커맨드 입력 필드 (세션에 직접 메시지 전송)

### 3.5 Real-time WebSocket **[LIVE]**

WebSocket 연결로 다음 이벤트를 실시간 브로드캐스트:
- `session_update` — 세션 상태 변경 (새 세션, 상태 전환)
- `task_update` — 태스크 목록 변경
- `conversation_update` — 새 대화 턴 추가
- `session_action` — stop/close/trash 액션 실행

클라이언트는 30초 폴링 + WebSocket 이중 업데이트.

### 3.6 Personal Stats **[LIVE]**

`/api/dashboard/stats?userId=...&period=day|week|month`

기간별 사용자 통계:
- 생성한 세션 수, 사용한 턴 수
- 생성/머지한 PR 수, 커밋 수
- 추가/삭제 라인 수 (일반 + 머지)
- 워크플로우별 사용 빈도

MetricsEventStore (JSON 파일)에서 집계. 대시보드 상단에 Bar chart로 시각화.

### 3.7 OAuth Authentication **[LIVE]**

`/login` 페이지에서 Google/Microsoft OAuth2 로그인.

**인증 흐름**:
1. 사용자가 `/login`에서 Google 또는 Microsoft 버튼 클릭
2. OAuth authorization code flow 실행
3. 이메일 획득 → Slack 프로필과 case-insensitive 매칭
4. JWT 쿠키 발급 (HttpOnly, SameSite)
5. 이후 요청은 JWT 쿠키로 인증

**대체 인증**: API 토큰(Bearer header) 또는 쿠키 기반 토큰.
**미인증 처리**: API 요청 → 401, 브라우저 요청 → `/login`으로 302 리다이렉트.

**환경변수**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `DASHBOARD_JWT_SECRET`

> **참고**: refresh token 처리 미구현 (online-only access). 토큰 만료 시 재로그인 필요.

### 3.8 Conversation Recording **[LIVE]**

모든 세션의 user↔assistant 대화를 자동 기록.

- `recorder.ts`: 턴 단위로 기록, 인메모리 LRU 캐시(100개) + JSON 파일 영속화
- `summarizer.ts`: assistant 턴에 대해 Claude API로 자동 요약 생성 (제목 1줄 + 본문 3줄)
- `storage.ts`: `~/.soma-work/conversations/` 디렉토리에 JSON 파일로 저장
- `setOnTurnRecordedCallback()`: 대시보드 WebSocket으로 실시간 브로드캐스트 연결

### 3.9 Conversation Viewer (`/conversations`) **[LIVE]**

대화 이력을 웹에서 열람하는 독립 뷰어.

- `/conversations` — 전체 대화 목록 (소유자, 제목, 턴 수, 날짜)
- `/conversations/:id` — 개별 대화 상세 (모든 턴의 원문 표시)
- `/api/conversations` — JSON API (목록)
- `/api/conversations/:id` — JSON API (상세)
- `/api/conversations/:id/turns/:turnId/raw` — 개별 턴 원문
- `POST /api/conversations/:id/summarize` — 수동 요약 트리거

---

## 4. UI/UX Design

**디자인 시스템**: Bauhaus 미니멀리즘
- 다크 테마 (#1a1a2e 배경, #e0e0e0 텍스트)
- 그라디언트 탑바 (#667eea → #764ba2)
- 반응형 레이아웃: 4열 (데스크톱) → 2열 (태블릿) → 1열 (모바일)
- CSS 애니메이션: aura 글로우, 패널 슬라이드, 카드 호버 효과

**렌더링 방식**: 서버사이드 HTML 생성 (template literal) + 클라이언트사이드 SPA 동작 (fetch + DOM 조작). React/Vue 등 프레임워크 미사용.

---

## 5. Data Model

### KanbanSession (대시보드 카드)
```typescript
{
  key: string;               // 세션 고유 키 (channelId:threadTs)
  title: string;             // 세션 제목
  ownerName: string;         // 소유자 표시명
  ownerId: string;           // Slack user ID
  workflow: string;          // 워크플로우 유형
  model: string;             // AI 모델명
  activityState: 'working' | 'waiting' | 'idle';
  sessionState: string;      // MAIN | SLEEPING
  terminated?: boolean;
  trashed?: boolean;
  conversationId?: string;   // 대화 기록 ID
  lastActivity: string;      // ISO timestamp
  issueUrl/Label/Title?: string;
  prUrl/Label/Title/Status?: string;
  mergeStats?: { totalLinesAdded, totalLinesDeleted };
  tokenUsage?: { totalInputTokens, totalOutputTokens, totalCostUsd, contextUsagePercent };
  tasks?: Array<{ content, status }>;
}
```

### ConversationRecord (대화 기록)
```typescript
{
  id: string;                // UUID
  channelId: string;         // Slack channel
  threadTs: string;          // Slack thread timestamp
  ownerId: string;
  ownerName: string;
  title?: string;
  workflow?: string;
  createdAt: number;         // Unix ms
  updatedAt: number;
  turns: ConversationTurn[]; // 시간순 턴 목록
}
```

### ConversationTurn (대화 턴)
```typescript
{
  id: string;                // UUID
  role: 'user' | 'assistant';
  timestamp: number;
  userName?: string;         // user turn only
  rawContent: string;
  summaryTitle?: string;     // assistant turn only (auto-generated)
  summaryBody?: string;      // assistant turn only (auto-generated)
}
```

### DashboardUser (인증 사용자)
```typescript
{
  userId: string;            // Slack user ID
  email: string;
  displayName: string;
  teamId: string;
}
```

---

## 6. API Reference

### Dashboard API
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/dashboard` | JWT/Token | Kanban HTML 페이지 |
| GET | `/dashboard/:userId` | JWT/Token | 사용자별 필터 |
| GET | `/api/dashboard/sessions` | JWT/Token | Kanban 보드 데이터 |
| GET | `/api/dashboard/stats` | JWT/Token | 사용자 통계 |
| GET | `/api/dashboard/users` | JWT/Token | 전체 사용자 목록 |
| GET | `/api/dashboard/session/:convId` | JWT/Token | 세션 상세 (대화 턴) |
| POST | `/api/dashboard/session/:key/stop` | JWT/Token | 세션 중단 |
| POST | `/api/dashboard/session/:key/close` | JWT/Token | 세션 종료 |
| POST | `/api/dashboard/session/:key/trash` | JWT/Token | 세션 숨김 |
| POST | `/api/dashboard/session/:key/command` | JWT/Token | 세션에 메시지 |
| WS | `/ws` | — | 실시간 이벤트 |

### Conversation API
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/conversations` | JWT/Token | 대화 목록 HTML |
| GET | `/conversations/:id` | JWT/Token | 대화 상세 HTML |
| GET | `/api/conversations` | JWT/Token | 대화 목록 JSON |
| GET | `/api/conversations/:id` | JWT/Token | 대화 상세 JSON |
| GET | `/api/conversations/:id/turns/:turnId/raw` | JWT/Token | 턴 원문 |
| POST | `/api/conversations/:id/summarize` | JWT/Token | 요약 트리거 |

### Auth API
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/login` | Public | 로그인 페이지 HTML |
| GET | `/auth/google` | Public | Google OAuth 시작 |
| GET | `/auth/google/callback` | Public | Google OAuth 콜백 |
| GET | `/auth/microsoft` | Public | Microsoft OAuth 시작 |
| GET | `/auth/microsoft/callback` | Public | Microsoft OAuth 콜백 |

---

## 7. Evolution History

| PR | Date | Phase | Key Changes |
|----|------|-------|-------------|
| #192 | 2026-03 | v1 | 3열 Kanban + WebSocket + Slide panel + OAuth + 대화 기록 |
| #271 | 2026-03 | v2 | 4열 Kanban + Bauhaus 디자인 + Aura + 세션 액션 + Task list + Command input |
| #280 | 2026-03-31 | bugfix | SyntaxError 수정 (template literal escaping) + Biome lint/format |
| #283 | 2026-03-31 | test | 기본 회귀 테스트 (JS 문법 + 이스케이프 패턴) |
| #284 | 2026-03-31 | test | Hostile input 테스트 (JSON 보존 + escJs 순서) |
| #297 | 2026-04-01 | test | 완전성 검증 + 동적 가드 테스트 |

---

## 8. Known Gaps & Future Work

### 구현 필요 (WIRED but not connected)
1. **세션 액션 핸들러 와이어링**: `setDashboardStopHandler()`, `setDashboardCloseHandler()`, `setDashboardTrashHandler()`, `setDashboardCommandHandler()`가 `index.ts`에서 실제 세션 매니저에 연결되어야 Stop/Close/Trash/Command가 동작한다.

### 아키텍처 개선 (Codex 권장)
2. **인라인 onclick → data-* 속성 + 위임 이벤트 리스너**: 현재 `<script>` 안에서 문자열 조립으로 onclick을 생성하는 패턴은 이스케이프 버그에 취약하다. data-* 속성과 이벤트 위임으로 전환하면 이스케이프 레이어가 3겹에서 1겹으로 줄어든다.

### 기능 확장
3. **OAuth refresh token**: 현재 online-only access. 토큰 만료 시 재로그인 필요.
4. **RBAC (역할 기반 접근 제어)**: 현재 인증된 사용자는 모든 세션에 액션 가능. 세션 소유자만 액션 가능하도록 프론트엔드에서 체크하지만, 다른 사용자의 세션 데이터는 열람 가능.
5. **Playwright 브라우저 테스트**: 서버사이드 테스트만 존재. DOM 렌더링/클릭 동작 검증을 위한 E2E 테스트 미구현.
6. **React/SPA 전환**: 67KB template literal 단일 파일은 유지보수 한계. 컴포넌트 기반 프레임워크 도입 검토.
7. **대화 검색**: 대화 내용 전문 검색 미구현.
8. **대시보드 알림**: 세션 상태 변경 시 브라우저 알림 미구현.

---

## 9. Security Considerations

- JWT 쿠키: HttpOnly + SameSite 플래그 적용
- 세션 액션 권한: `requireSessionOwner()` — 세션 소유자만 Stop/Close/Trash/Command 가능
- API 인증: 모든 `/api/*` 경로에 `authMiddleware` 적용
- XSS 방어: `esc()` 함수로 HTML 이스케이프 + `escJs()` 함수로 JS 이스케이프
- CSRF: JWT 쿠키 + SameSite로 기본 방어, 전용 CSRF 토큰은 미구현
