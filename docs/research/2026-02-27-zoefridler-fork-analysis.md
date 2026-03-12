# ZoeFridler/claude-code-slack-bot Fork 분석

> **Source**: https://github.com/mpociot/claude-code-slack-bot/compare/main...ZoeFridler:claude-code-slack-bot:dev
> **Date**: 2026-02-27
> **Commits**: 20개
> **변경 파일**: 7개 (신규 1 / 수정 6)
> **주요 변경**: +2,220 / -184 lines

## 1. 핵심 피처: Multi-Agent 시스템

### 1.1 Agent Manager (agent-manager.ts, 928줄)

같은 Slack 채널 내에서 이름 있는 다수의 에이전트를 생성하고 관리하는 시스템.

#### 에이전트 CRUD
- `create agent <name> on <path>`: 이름 + 작업 디렉토리로 에이전트 생성
- `create agent <name> from <template> on <path>`: 템플릿 기반 생성
- `remove agent <name>`: 에이전트 삭제 (확인 단계 30초 타임아웃)
- `rename agent <old> to <new>`: 이름 변경
- `list agents`: 채널 내 전체 에이전트 목록

#### 에이전트 설정
- **Rules (규칙)**: 에이전트별 행동 규칙 설정/해제
  - `rules <agent> <text>` / `clear rules <agent>`
- **Global Rules (전역 규칙)**: 채널 내 모든 에이전트에 적용
  - `global rules <text>` / `clear global rules` / `show global rules`
- **Quiet Mode**: 도구 사용 메시지 숨김
  - `quiet <agent> on|off`
- **Model 선택**: 에이전트별 모델 지정
  - `model <agent> opus|sonnet`
  - opus = 🧠 smart, sonnet = ⚡ fast
- **Status**: 에이전트 상세 상태 확인
  - `status <agent>`

#### 영속화
- `agents.json`: 에이전트 설정 디스크 저장 (재시작 시 복원)
- `schedules.json`: 스케줄 설정 저장
- `global-rules.json`: 전역 규칙 저장
- `sessions.json`: 대화 세션 저장 (세션 ID 보존)

### 1.2 에이전트 템플릿 시스템

5개 기본 템플릿 제공:

| 템플릿 | 설명 |
|--------|------|
| `reviewer` | 코드 리뷰 (버그, 스타일, 보안) |
| `devops` | CI/CD, 인프라, 배포 |
| `docs` | 문서화, API 문서, README |
| `security` | OWASP Top 10, 인증, 시크릿 |
| `tester` | 단위/통합 테스트, 엣지 케이스 |

### 1.3 에이전트 메시징

#### 개별 메시지
- `@<agent> <message>`: 특정 에이전트에 메시지 전송
- `<agent-name> <message>`: @ 없이 이름으로 직접 호출
- `tell <agent> to ...` / `ask <agent> about ...`: 자연어 호출

#### 브로드캐스트
- `@all <message>`: 채널 내 모든 에이전트에 동시 전송

#### Agent-to-Agent 통신
- `@<agent1> ask @<agent2> <question>`: agent1이 agent2에게 질문
  - agent2의 응답을 가져와서 agent1에게 전달
  - agent1이 해석/종합하여 최종 응답

### 1.4 Multi-Turn Collaboration

```
collab @<agent1> @<agent2> <task>
```

- 두 에이전트가 교대로 작업 수행 (turn-based)
- 각 에이전트가 작업 후 다음 에이전트에게 인수
- "DONE" 키워드로 완료 신호
- 최대 10턴 제한
- 컬러 사이드바로 에이전트 구분

### 1.5 스케줄된 태스크

```
schedule <agent> every <N> <min|hours|days> <message>
```

- 주기적으로 에이전트에게 메시지 자동 전송
- `unschedule <id>`: 스케줄 제거
- `schedules`: 목록 확인
- 재시작 시 타이머 자동 복원

## 2. Slack UX 개선

### 2.1 컬러 에이전트 메시지
- 10색 팔레트 자동 할당 (`#3498DB`, `#2ECC71`, `#E74C3C` ...)
- Slack attachment API 활용한 컬러 사이드바
- 인사말, 응답, 도구 출력, 협업 메시지 모두 적용

### 2.2 Rich Tool Output (컬러 diff)
- **Edit**: 삭제 코드 → 🔴 빨강 사이드바, 추가 코드 → 🟢 초록 사이드바 (GitHub 스타일)
- **Write (신규 파일)**: 🔵 파란 사이드바
- **Bash**: ⬛ 다크 사이드바
- **Glob/Grep**: 🔍 검색 아이콘
- **Read**: 👁 아이콘

### 2.3 Live Status Heartbeat
- 5초 간격으로 상태 메시지 업데이트
- 경과 시간 + 현재 수행 도구 표시
- "Thinking" / "Working" / "Responding" + tool name
- 에이전트가 활성/멈춤 상태 확인 가능

### 2.4 자연어 명령 파싱
- 정확한 명령 구문 불일치 시 NLP 폴백
- `"add a global rule to not delete files"` → `set_global_rules`
- `"make lina fast"` → `set_model lina sonnet`
- `"show me my agents"` → `list_agents`
- `"how is lina doing"` → `agent_status`
- 우선순위: 에이전트 이름으로 시작 > tell/ask 패턴 > 규칙 > 생성/삭제 > 상태

### 2.5 세션 손상 자동 복구
- `resumeSession` 시 이미지 데이터 손상 감지
- `Could not process image` / `invalid_request_error` 에러 → 자동으로 세션 초기화 후 재시도
- 사용자에게 투명하게 처리

## 3. 기타 변경

### 3.1 Permission MCP 서버 경로 수정
- 하드코딩 경로 → `path.join(__dirname, ...)` 동적 경로

### 3.2 에이전트는 bypassPermissions
- 에이전트 세션은 자동으로 권한 우회 (자율 모드)

### 3.3 SDK 업그레이드
- `@anthropic-ai/claude-code` 1.0.128 (Node 22 호환)

## 4. 변경 파일 요약

| 파일 | 상태 | 줄 변경 |
|------|------|---------|
| `src/agent-manager.ts` | 신규 | +928 |
| `src/slack-handler.ts` | 수정 | +1104/-173 |
| `src/claude-handler.ts` | 수정 | +117/-4 |
| `src/types.ts` | 수정 | +65/-1 |
| `package.json` | 수정 | +1/-1 |
| `package-lock.json` | 수정 | +5/-5 |
| `.gitignore` | 수정 | +5/-1 |

## 5. 아키텍처 다이어그램

```
User Message
    │
    ▼
AgentManager.parseMessage() ─── 자연어 NLP 폴백
    │
    ├── create_agent → AgentManager.createAgent()
    ├── agent_message → @agent → executeQuery(identityPrompt + message)
    ├── broadcast → @all → 각 에이전트에 순차 전송
    ├── agent_ask_agent → agent1이 agent2에 질문 → 응답 종합
    ├── collaborate → turn-based 교대 작업 (max 10턴)
    ├── schedule → setInterval 기반 주기 실행
    └── set_rules / set_model / quiet / status / ...
```

---

## soma-work 적용 가능 피처 리스트

### P1 - 높은 가치, 비교적 쉬운 적용

| # | 피처 | 설명 | soma-work 현황 | 적용 난이도 |
|---|------|------|---------------|-------------|
| 1 | **Rich Tool Output (컬러 diff)** | Edit → 빨강/초록, Bash → 다크, Write → 파란 사이드바 | Block Kit 기반 포맷터 있음, attachment 미사용 | 중 |
| 2 | **Live Status Heartbeat** | 5초 간격 경과 시간 + 현재 도구 표시 | mcp-status-tracker 있으나 heartbeat 없음 | 중 |
| 3 | **세션 손상 자동 복구** | 이미지 데이터 손상 시 자동 세션 초기화 + 재시도 | 없음 (세션 에러 시 수동 renew 필요) | 낮 |
| 4 | **삭제 확인 단계** | 에이전트 삭제 시 30초 confirmation | 없음 (위험한 작업에 확인 없음) | 낮 |

### P2 - 높은 가치, 중간~높은 노력

| # | 피처 | 설명 | soma-work 현황 | 적용 난이도 |
|---|------|------|---------------|-------------|
| 5 | **Multi-Agent per Channel** | 채널 내 다수 에이전트 (이름, cwd, 규칙 별도) | 1채널=1봇 모델 | 높 |
| 6 | **Agent Templates** | reviewer/devops/security 등 프리셋 | persona 시스템이 유사하나 별도 세션은 아님 | 중 |
| 7 | **Agent-to-Agent 통신** | `@agent1 ask @agent2` 패턴 | 없음 | 높 |
| 8 | **Multi-Turn Collaboration** | 두 에이전트 교대 작업 (collab) | 없음 | 높 |
| 9 | **컬러 에이전트 메시지** | 에이전트별 고유 색상 사이드바 | 없음 (persona는 이름만 다름) | 중 |
| 10 | **자연어 명령 파싱** | 정확한 구문 없이도 의도 파악 | 정규식 기반 명령만 지원 | 중 |

### P3 - 참고할만하지만 우선순위 낮음

| # | 피처 | 설명 | soma-work 현황 | 적용 난이도 |
|---|------|------|---------------|-------------|
| 11 | **에이전트별 Model 선택** | opus/sonnet 에이전트 단위 지정 | `/model` 명령으로 세션 단위 변경 가능 | 낮 |
| 12 | **Global Rules** | 채널 모든 에이전트 공통 규칙 | CLAUDE.md가 이 역할 | 낮 |
| 13 | **Scheduled Tasks** | 주기적 에이전트 메시지 (setInterval) | 유스케이스 불분명 | 중 |
| 14 | **Quiet Mode** | 도구 메시지 숨김 | verbosity 명령이 유사 기능 | 낮 |

### 적용하지 않을 항목

| 피처 | 이유 |
|------|------|
| Full Multi-Agent 시스템 | soma-work는 1유저=1세션 모델이며, persona로 역할 분리 충분 |
| NLP 명령 파싱 (full) | 명령어 체계가 이미 확립됨, 오탐지 위험 (remove 사건) |
| Agent 영속화 (agents.json) | 에이전트 개념 자체가 다름 |

### 적용 추천 순서

1. **P1-3 세션 손상 자동 복구** → 즉시 적용, 에러 복원력 향상
2. **P1-1 Rich Tool Output** → attachment 컬러 사이드바로 diff 가시성 개선 (Block Kit 보완)
3. **P1-2 Live Status Heartbeat** → 경과 시간 표시로 "멈춤" 인지 해소
4. **P1-4 삭제 확인 단계** → 위험한 명령에 confirmation 추가
5. **P2-10 자연어 명령 (부분)** → 주요 명령의 alias/자연어 인식 추가 (전체 NLP 아닌 선별적)
6. **P2-6 Agent Templates** → persona 시스템에 프리셋 템플릿 추가

---

## kkhfiles fork와의 비교

| 관점 | kkhfiles | ZoeFridler |
|------|----------|------------|
| **철학** | 1인 사용 UX 극대화 (모바일, rate limit, i18n) | Multi-Agent 오케스트레이션 |
| **SDK** | CLI spawning (정책 회피) | Agent SDK 유지 |
| **권한** | 3단계 (default/safe/trust) | bypassPermissions (에이전트) |
| **세션** | 피커, 스캐너, 연속성 | 에이전트별 분리 세션 |
| **핵심 가치** | Rate limit 대응, 세션 복원, i18n | 에이전트 협업, 컬러 diff |
| **코드 규모** | +5,388 / -1,371 (28파일) | +2,220 / -184 (7파일) |
| **실용성** | 높음 (일상 사용 UX) | 실험적 (multi-agent 탐구) |
