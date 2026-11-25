# 39 — 재시작·재시도 복원력 아키텍처

Status: planned · 작성 2026-11-25 · 기준 커밋 main `a9041b4d` · 스펙 [38-restart-resilience-spec.md](38-restart-resilience-spec.md)

> 한 줄 결론: 네 작업 단위가 서로 다른 파일 묶음을 고친다. W1은 계정 저장소(`src/cct-store/store.ts`)와 기동(`token-manager`
> `init`), W2는 본문 판별(`packages/common/src/rate-limit.ts`)과 그 본문 호출자 셋, W3은 재시도 예약·합성 턴(`slack-handler`)과
> 새 프롬프트·대시보드 분류, W4는 계정 풀 대기 시각(스트림 실행기 → 세션 → Slack 핸들러 · 목표 루프)이다. 줄 번호는 기준 커밋 기준이다.

## 0. 미니맵

```
39 아키텍처
├─ 1. W1 계정 저장소 — 직렬화 · 손상 처리 · 기동 대기
├─ 2. W2 본문 판별 — 메시지 하나 전체 규칙
├─ 3. W3 오류 재시도 — 전용 머리 · 사유 · 제목 · 대시보드
├─ 4. W4 계정 풀 대기 — 원래 대기 보존 · 세션 시각 · 두 확인 지점
├─ 5. 파일 소유권 (WU별, 서로소)
└─ 6. 테스트 지도
```

## 1. W1 계정 저장소 (#1435)

지금: `save()`(`store.ts:209-215`)와 `persistMigrated()`(`:281-287`)가 `proper-lockfile`을 `stale 30s · update 5s`로 잡고
`onCompromised`가 없다 → 라이브러리 기본값이 fs 콜백 안에서 던진다 → `index.ts:2885` uncaughtException → 모든 Claude 하위
프로세스 SIGKILL → exit 1. `mutate`(`:236-260`)는 `RevisionConflictError`만 재시도한다. `load()`→`persistMigrated()`(`:183-184`)는
`mutate`의 재시도 밖이다. 기동은 `index.ts:342` `tokenManager.init` → `ensureActiveSlot` → `mutate`에서 `ELOCKED`로 약 4.75초 뒤 실패.

바뀜:
- **직렬화.** `CctStore` 인스턴스 하나가 `save`/`persistMigrated`를 프로미스 체인 하나로 줄 세운다. 같은 프로세스 안에서는 파일 잠금
  경쟁이 생기지 않는다(그날 밤 잠금을 가져간 쪽은 같은 프로세스의 다른 쓰기로 추정).
- **손상 처리.** 두 잠금 지점이 옵션 상수 하나를 공유한다. `onCompromised`는 던지지 않고 경고 로그 + 이번 획득의 손상 표시만 한다.
  rename 직전에 표시를 보고, 손상이면 쓰지 않고 `LockCompromisedError`를 던진다. rename 뒤 손상은 로그만. `finally`의
  `release()`는 `ERELEASED`를 삼켜 원래 결과·오류를 덮지 않는다.
- **재시도 집합.** `mutate`가 `RevisionConflictError ∪ LockCompromisedError`를 다시 읽고 재시도한다. 마이그레이션 쓰기도 같은 오류를
  재시도한다.
- **기동 대기.** `init`이 `ELOCKED`를 stale 창+여유(약 40초)까지 재시도한다. 잠금을 지우지 않는다(38 §4 D1).

## 2. W2 본문 판별 (#1436)

지금: `textIndicatesRetryableRateLimit`(`rate-limit.ts:176-181`)은 `retry in/after N` 정규식과 게이트웨이 낱말을 본문 어디서든
찾는다. `textIndicatesUsageLimit`(`:190-196`)은 `CAP_NOTICE_PATTERNS`(`:30-37`)를 어디서든 찾는다. 본문 호출자는
`stream-executor.ts:3098`(계정 풀) · `:3128`(사용량 한도) · `claude-handler.ts:1156`(one-shot 계정 풀) · `:1210`(one-shot
사용량 한도 → `:1232` 계정 교체). `guardText`는 메시지들을 `\n`으로 이어 붙여(`stream-processor.ts:2519-2523`) 메시지 경계가 사라진다.

바뀜:
- **본문 모드 판별 둘**(이름은 구현에서 확정): 입력 = 본문 전체와(있으면) 마지막 어시스턴트 메시지. 둘 중 하나가 1500자 이하이고
  게이트웨이 모양으로 시작하면 참. 계정 풀 모양 = (`API Error: ` | `Error: `)? + `Request rejected (429)`. 사용량 한도 모양 =
  완전한 알림 문장 목록(38 §4 D3, #1436 판정 규칙). 지연은 맞은 텍스트에서만 읽는다.
- **문구 변화 감지.** 짧은 본문이 `CAP_NOTICE_PATTERNS`에는 맞고 시작형 목록에는 안 맞으면 경고 로그 한 줄(판정은 거짓).
- `StreamResult`가 마지막 어시스턴트 메시지(숨김 처리 제외)를 따로 싣는다.
- 본문 호출자 넷이 본문 모드를 쓴다(one-shot은 메시지 경계가 없어 본문 전체 규칙만). 오류·stderr 호출자(`stream-executor.ts:4142`,
  `:5296-5297`, `goal-loop-controller.ts:105`, `dispatch-recovery.ts:178`)는 지금 판별을 그대로 쓴다.
- `rate-limit.ts:170-174`의 "Content-safe by construction" 주석을 바로잡는다.

## 3. W3 오류 재시도 (#1437)

지금: `processMessage`의 복구 가능 분기(`slack-handler.ts:3413-3454`)가 `scheduleErrorRetry(target, …, lastErrorContext)`를 부른다.
`lastErrorContext`는 파일 접근 분기(`stream-executor.ts:4793`)에서만 채워진다. 타이머(`slack-handler.ts:9016-9018`)는
`clearPendingErrorRetry`로 `pendingRetryDetail.reason`까지 지운 뒤 `autoResumeSession`을 부르고, 제목·사유가 없으면 재시작
프롬프트(`src/prompt/restart.prompt`)만 나간다. 대시보드 `sysTurnInfo`(`dashboard.ts:23593-23604`)는 ⚠️ 사유 줄이 없으면 `restart`.

바뀜:
- 타이머와 재기동 재무장(`resumePendingErrorRetries`, `:8923`)이 지우기 전에 `pendingRetryDetail.reason`, 세션 title·workflow를 읽어
  `autoResumeSession`에 "오류 재시도" 종류로 넘긴다.
- `autoResumeSession`은 그 종류일 때 `src/prompt/error-retry.prompt`(신규 — 재시도임을 밝히고 #927 확인 문단 유지) + `⚠️ 이전 시도 중
  오류 발생: <사유>` + `세션 제목: …`을 보낸다. 진짜 재시작 복구(`notifyCrashRecovery`, `:8582`)는 그대로.
- `dashboard.ts`에 재시도 머리를 추가해 ⚠️ 줄이 없어도 `retry`로 분류한다. 기존 머리 분류는 바꾸지 않는다(옛 기록 호환).
- 새 프롬프트 파일은 `build`의 `cp -r src/prompt dist/`로 번들에 들어간다.

## 4. W4 계정 풀 대기 (#1438)

지금: 계정 풀 판별(`stream-executor.ts:3098-3110`)과 stderr 경로(`:5291-5298`)가 지연을 1시간(`rate-limit.ts:134`)으로 자른다.
소진 분기(`:4863-4865`)는 횟수만 0으로 되돌린다 → `v1-query-adapter.ts:385-401`이 빈 `end_turn`을 만든다 → 목표 루프
(`goal-loop-controller.ts:399-400, 476-487`)가 끊긴 턴으로 보고 이어하기를 쓴다. 목표 루프의 대기 게이트는 평가 호출 실패용
`evalBackoffUntil`(`:435-449`)뿐이다. Slack 핸들러는 목표 컨트롤러를 부르기 전에 #948 재개권(`goalErrorResumeSpent`,
`slack-handler.ts:7646-7662`)을 확인·차감한다.

바뀜:
- 두 경로가 잘린 지연 옆에 원래 대기(ms)를 함께 넘긴다.
- 소진 분기가 세션에 `poolWaitUntil`(이름은 구현에서 확정) = 소진 시각 + min(원래 대기, 48시간)을 기록하고 저장한다.
- `releaseDeferredGoalDriver`가 재개권을 보기 **전에** 그 시각을 본다. 남아 있으면 재개권을 쓰지 않고 그 시각에 깨우기 하나를 건다.
  목표 루프도 끊긴 턴 판정 전에 같은 시각을 본다(이어하기 소비 없음).
- 해제: 성공 턴, 사람 메시지(인그레스), 깨우기 발화. 재기동 뒤에는 저장된 시각으로 깨우기를 다시 건다.

## 5. 파일 소유권 (WU별)

| ID | 작업 단위 | 소유 파일 | Status |
|---|---|---|---|
| W1 | 계정 저장소 | `src/cct-store/store.ts`, `src/token-manager.ts`(`init` 재시도만), 그 테스트 | 🔴 |
| W2 | 본문 판별 | `packages/common/src/rate-limit.ts`, `packages/slack/src/stream-processor.ts`, `packages/slack/src/pipeline/stream-executor.ts`(`:3098` · `:3128` 호출만), `src/claude-handler.ts`(`:1156` · `:1210`), 그 테스트 | 🔴 |
| W3 | 오류 재시도 | `src/slack-handler.ts`(재시도 예약·`autoResumeSession`), `src/prompt/error-retry.prompt`, `src/conversation/dashboard.ts`, 그 테스트 | 🔴 |
| W4 | 계정 풀 대기 | `packages/slack/src/pipeline/stream-executor.ts`(지연 보존·소진 분기), `src/slack-handler.ts`(`releaseDeferredGoalDriver`), `src/slack/goal-loop-controller.ts`, 세션 저장 필드, 그 테스트 | 🔴 |

W2와 W4는 `stream-executor.ts`, W3과 W4는 `slack-handler.ts`를 함께 건드린다(서로 다른 구역). 그래서 W4는 W2·W3 머지 뒤에 한다.
W1 · W2 · W3은 파일이 서로소라 병렬로 할 수 있다.

## 6. 테스트 지도

| 인수 | 테스트 위치(예정) |
|---|---|
| A1 · A2 · A3 | `src/cct-store/__tests__/store.test.ts`, `src/__tests__/token-manager.test.ts` |
| A4 · A5 · A6 | `packages/common/src/__tests__/rate-limit.test.ts`, `packages/slack/src/pipeline/__tests__/stream-executor.incident-output.test.ts`(오판을 고정한 픽스처 교체), one-shot 테스트 |
| A7 | `src/__tests__/auto-resume.test.ts`, `src/__tests__/error-retry-restart.test.ts`, `src/conversation/__tests__/dashboard-system-turns-client.test.ts` |
| A8 · A9 | `src/__tests__/slack-handler.followup.test.ts`(실제 핸들러 경유), `src/slack/__tests__/goal-loop-controller.test.ts`, 세션 저장 테스트 |
| A10 | 배포 뒤 실측 — `restart-resilience/loop.md` |
