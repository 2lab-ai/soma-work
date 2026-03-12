# kkhfiles/claude-code-slack-bot Fork 분석

> **Source**: https://github.com/mpociot/claude-code-slack-bot/compare/main...kkhfiles:claude-code-slack-bot:main
> **Date**: 2026-02-27
> **Commits**: 44개
> **변경 파일**: 28개 (신규 12 / 수정 16)
> **주요 변경**: +5,388 / -1,371 lines

## 1. 아키텍처 변경

### 1.1 Agent SDK → CLI Process Spawning 마이그레이션
- `@anthropic-ai/claude-agent-sdk` 제거 → `child_process.spawn('claude')` 방식으로 전환
- **이유**: SDK + OAuth 구독 = Anthropic 정책 위반
- `cli-handler.ts` (464줄) 신규 추가
  - `CliProcess` 클래스: child_process 래핑, `AsyncIterable<CliEvent>` 인터페이스 제공
  - stdout에서 `stream-json` 이벤트 파싱
  - stdin으로 프롬프트 전달 (`--allowedTools` variadic arg가 positional arg를 먹는 문제 우회)
  - `interrupt()`: SIGINT (macOS/Linux), `kill()` (Windows)
  - `CliHandler` 클래스: 세션 관리 + CLI 프로세스 스폰

### 1.2 세션 영속화 (.session-state.json)
- 7일 보존, debounced 쓰기 (5초)
- `lastAssistantUuid` 추적으로 conversation fork 방지 (`resumeSessionAt`)
- 봇 재시작 시 세션 자동 복원 (pm2 restart recovery)

### 1.3 Working Directory 영속화 (.working-dirs.json)
- 기존: 메모리 only → 봇 재시작 시 모든 cwd 설정 소실
- 변경: 디스크에 영속화, DM 쓰레드 → DM 레벨 폴백 자동 생성

## 2. 권한 시스템

### 2.1 3단계 권한 모드
| 모드 | 명령어 | 동작 |
|------|--------|------|
| **Default** | `-default` | Bash, Edit, Write, MCP → Slack 버튼 승인 필요 (기본값) |
| **Safe** | `-safe` | 편집 자동 승인, Bash/MCP 승인 필요 |
| **Trust** | `-trust` | 모든 도구 자동 승인 (bypassPermissions) |

### 2.2 도구 승인 UI
- Approve / Deny 버튼
- **"Always Allow [tool]"** 버튼: 채널 단위 자동 승인
- **One-time approval**: 개별 건 승인 (채널 전역 X)
- auto-approve 타임아웃 제거 → 사용자 명시적 응답 대기 (무기한)
- CLI 모드: `permission_denials` 감지 → 승인 후 resume

### 2.3 Plan 모드
- `-plan <prompt>`: 읽기 전용 실행 → **Execute 버튼**으로 세션 resume
- `--permission-mode plan` CLI 플래그 사용

## 3. Rate Limit 대응

### 3.1 감지 메커니즘
- `rate_limit_event` (CLI stream-json)
- `result.is_error` (CLI result)
- ~~assistant 텍스트 매칭~~ (false positive로 제거됨)

### 3.2 재시도 UI
- 예상 재시도 시간 표시 (리셋 시간 + 3분 버퍼)
- **예약 재시도 모달**: 프롬프트 편집 가능 (3000자 이하)
- 리셋 시간에 @멘션 알림 자동 예약 (재시도/취소 시 알림 취소)

### 3.3 API Key Fallback
- Rate limit 시 "Continue with API key" 버튼
- `-apikey` 명령으로 API 키 등록 (`.api-keys.json` 영속화)
- Rate limit 해제 시 자동으로 구독 인증 복귀
- **Spending Limit** (`-limit`): 채널별 API 키 사용 한도 설정
- 한도 초과 시 자동 비활성화

## 4. 세션 관리 & 피커

### 4.1 세션 피커 (모바일 친화)
- `-r` / `resume` / `continue` / `계속` / `ㄱㄱ` / `let's go` 등 자연어 alias
- 최근 10개 세션 버튼 표시 (프로젝트/브랜치/경로 포함)
- 선택 시 cwd 자동 전환 + 같은 쓰레드에서 세션 재개
- 5분 자동 만료
- 최대 15세션 표시 (Slack 50-block 제한 대응)
- "Show more" 버튼 + 가이드 텍스트

### 4.2 세션 스캐너 (session-scanner.ts)
- `~/.claude/projects/` 하위 모든 프로젝트 스캔
- `sessions-index.json` + `.jsonl` 파일 병합
- 빈 세션 필터링, 실제 파일 mtime 기반 정렬
- `registerSession()`: Slack에서 생성한 세션을 CLI index에 등록

### 4.3 세션 연속성
- `lastAssistantUuid` 추적 → `resumeSessionAt`으로 fork 방지
- 세션 타임아웃 제거 (같은 쓰레드에서 무기한 대화 유지)
- 24시간 in-memory 세션 정리 (5분 간격)

## 5. i18n (다국어 지원)

### 5.1 messages.ts (400줄)
- ~120개 번역 쌍 (en/ko)
- `t(key, locale, params?)` 함수: `{{placeholder}}` 보간
- Slack `users.info` API로 locale 자동 감지 (`ko-*` → Korean)
- 모든 UI 문자열에 적용

### 5.2 i18n 적용 범위
- 상태 메시지, 명령어 응답, 에러, 도구 승인
- Working directory, 세션 피커, Rate limit UI
- Todo list, Plan mode, Welcome message
- Help 텍스트 (전체 한글/영문)

## 6. Schedule Manager (세션 자동 시작)

### 6.1 기능
- `-schedule add <hour>`: 매일 특정 시간에 세션 자동 시작
- 랜덤 jitter (+5~25분): 탐지 방지
- 랜덤 인사말: `say "word"` 또는 `N+M` 덧셈
- 5시간 후 자동 follow-up (세션 윈도우 커버)
- haiku 모델 강제 (토큰 절약)

### 6.2 충돌 방지
- 기존 5시간 세션 윈도우 내 시간 추가 거부
- `.schedule-config.json` 영속화

## 7. UX 개선

### 7.1 실시간 진행 표시
- `stream_event`로 현재 실행 중 도구명 표시
- 읽기 전용 도구 (Grep, Read, Glob) → 상태 메시지에서만 표시
- 완료 시 도구 사용 요약 (예: `Grep ×5, Read ×2`)

### 7.2 리액션 관리
- 리액션을 Set으로 추적
- 상충하는 리액션 자동 제거 (✅와 🤔 동시 표시 방지)
- Anchor 리액션 (⏳): 쿼리 실행 중 Slack 라인 점프 방지

### 7.3 기타
- 새 쓰레드 첫 응답에 command hint 표시
- `-stop` 명령: SIGINT로 graceful 중단
- `-cost`: 마지막 쿼리 비용/세션 정보
- `-version`: 봇 버전 + origin/main 대비 업데이트 확인
- 채널 바깥(DM 등)에서 info 명령 → 채널에 직접 응답

### 7.4 Windows 호환
- `path.isAbsolute()` 크로스 플랫폼
- pm2 기반 프로세스 관리
- setup/update/start/stop 스크립트 (.sh + .bat)

## 8. 변경 파일 요약

| 파일 | 상태 | 줄 변경 |
|------|------|---------|
| `src/cli-handler.ts` | 신규 | +464 |
| `src/messages.ts` | 신규 | +400 |
| `src/session-scanner.ts` | 신규 | +295 |
| `src/schedule-manager.ts` | 신규 | +265 |
| `src/version.ts` | 신규 | +97 |
| `src/slack-handler.ts` | 수정 | +2035/-439 |
| `src/claude-handler.ts` | 수정 | +173/-72 |
| `src/working-directory-manager.ts` | 수정 | +95/-38 |
| `src/todo-manager.ts` | 수정 | +20/-19 |
| `src/index.ts` | 수정 | +23/-6 |
| `src/mcp-manager.ts` | 수정 | +13/-7 |
| `src/types.ts` | 수정 | +10/-0 |

---

## soma-work 적용 가능 피처 리스트

아래는 이 fork에서 우리 서비스(soma-work)에 적용할만한 피처를 우선순위별로 정리한 것입니다.

### P1 - 높은 가치, 비교적 쉬운 적용

| # | 피처 | 설명 | soma-work 현황 | 적용 난이도 |
|---|------|------|---------------|-------------|
| 1 | **Rate Limit 재시도 UI** | 리셋 시간 표시 + 예약 재시도 모달 + @멘션 알림 | 없음 | 중 |
| 2 | **도구 사용 요약** | 완료 시 사용된 도구 카운트 요약 (Grep ×5, Read ×2) | `mcp-status-tracker`에 일부 있음 | 낮 |
| 3 | **리액션 상태 관리** | 상충 리액션 자동 제거 (Set 기반 추적) | 있으나 개선 가능 | 낮 |
| 4 | **Anchor 리액션 (⏳)** | 쿼리 실행 중 Slack 라인 점프 방지 | 없음 | 낮 |
| 5 | **첫 응답 command hint** | 새 쓰레드 첫 응답에 사용 가능 명령어 힌트 | 없음 | 낮 |

### P2 - 높은 가치, 중간 노력

| # | 피처 | 설명 | soma-work 현황 | 적용 난이도 |
|---|------|------|---------------|-------------|
| 6 | **세션 피커 (모바일)** | 최근 세션 버튼 목록 + 자연어 alias | `/restore` 명령이 있으나 UI 개선 가능 | 중 |
| 7 | **API Key Fallback** | Rate limit 시 API 키 자동 전환 + 구독 복귀 | 없음 (API key 직접 사용) | 중 |
| 8 | **Spending Limit** | 채널별 API 키 사용 한도 설정 + 자동 비활성화 | 없음 | 중 |
| 9 | **3단계 권한 모드 UI** | default/safe/trust + "Always Allow" 버튼 | `bypass` 온오프만 있음 | 중 |
| 10 | **Query Cost 표시** | `-cost` 명령으로 마지막 쿼리 비용 확인 | 없음 | 낮 |

### P3 - 참고할만하지만 우선순위 낮음

| # | 피처 | 설명 | soma-work 현황 | 적용 난이도 |
|---|------|------|---------------|-------------|
| 11 | **i18n (messages.ts)** | 전체 UI 문자열 다국어 지원 | 한글 하드코딩 | 높 |
| 12 | **Schedule Manager** | 매일 자동 세션 시작 (jitter + follow-up) | 없음 (유스케이스 불분명) | 중 |
| 13 | **Plan 모드 + Execute** | 읽기 전용 계획 → 버튼으로 실행 | 없음 | 중 |
| 14 | **Version 관리** | `-version` + 자동 업데이트 확인 | 없음 | 낮 |
| 15 | **WD 영속화** | Working directory 디스크 저장 | 이미 유사 구현 | 낮 |
| 16 | **세션 영속화** | .session-state.json (7일 보존) | SessionRegistry가 이미 처리 | 낮 |

### 적용하지 않을 항목

| 피처 | 이유 |
|------|------|
| CLI Process Spawning | soma-work는 이미 Agent SDK 기반이며, SDK 사용이 정책적으로 허용됨 |
| Windows 호환 | macOS 전용 운영 환경 |
| pm2 프로세스 관리 | LaunchDaemon 기반으로 이미 운영 |
| setup/update 스크립트 | CI/CD 자동 배포로 불필요 |

### 적용 추천 순서

1. **P1-4 Anchor 리액션** + **P1-3 리액션 상태 관리** → 즉시 적용 가능, UX 개선
2. **P1-2 도구 사용 요약** → mcp-status-tracker 확장으로 구현
3. **P1-1 Rate Limit 재시도 UI** → 실사용 시 가장 큰 UX 개선
4. **P1-5 첫 응답 command hint** → 온보딩 개선
5. **P2-10 Query Cost 표시** → SDK result에서 비용 추출
6. **P2-9 3단계 권한 모드** → bypass 대신 세분화
7. **P2-6 세션 피커** → restore 명령 UI 개선
