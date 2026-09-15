# Loop — Slack Agent UI + Followup Queue

Status: planned
Date: 2026-09-14
SSOT: [`ssot.md`](ssot.md) · Spec: [`../04-slack-agent-ui-spec.md`](../04-slack-agent-ui-spec.md) ·
Arch: [`../05-slack-agent-ui-architecture.md`](../05-slack-agent-ui-architecture.md)

**현재 임무 = 구현 + 검증 + 프리뷰 배포(work-m64 제외) + Chrome 화면 검증.** "문서만"은 PRD 작성 세션에
한정됐던 과거 제한이며(SSOT §1.1) 구현 금지 지시가 아니다.
**현재 진행 상태: 로컬 통합 리시트는 확보됐고(빌드·스모크 exit 0, bounded `npm test` 8462 passed),
live acceptance는 미확인이다.** 두 가지는 다른 물건이다 — 로컬 green은 화면에서의 수용을 증명하지 않는다.
**완료(`verified`)로 닫힌 유닛은 없다**: A24 outbox 미구현, A34 메트릭 host 미배선, A32 결과/피드백 통합(B5)
미완결, lifecycle(shutdown/idle·adapter cancel·세션 마이그레이션 롤백) 잔여.

## 리시트

**전체 리시트 원장 = [`verification.md`](verification.md)** (게이트·실패 이력·targeted 로그·남은 구멍).
최신 frozen 리시트: `integration-frozen-build.log` build+tsc 오류 0, `integration-frozen-tests.log`
**482 files / 8478 tests passed**(17:39:45, 75.81s). 그 이전 bounded 실행은 8462 passed,
**기본 concurrency 실행은 10 failed** — 기본 `npm test` green은 주장하지 않는다.
**frozen 리시트는 이후 작업(dispatcher round2 · A24a 미배선 · U8 idle-shutdown 준비)보다 앞선다.**
배포는 blocked-by-user, Chrome 검증은 permission denied로 BLOCKED.

각 유닛은 RED → GREEN → REFACTOR(저장소 CLAUDE.md의 TDD 규칙)를 따르며, RED 로그 없이 push 금지.

## 유닛

| # | 유닛 | 산출물 | 커버하는 Acceptance | 상태 |
|---|---|---|---|---|
| U1 | FollowupQueue 도메인 + 상태기계 (`@soma/slack`) | 큐 타입·FIFO seq·dedup·capacity 거절(기본 100, `SOMA_FOLLOWUP_QUEUE_CAPACITY` 타입드 accessor) | A3, A4, A15 | 도메인 **57 테스트 · 외부 리뷰 승인** (스코프 완료이지 **제품 live 아님**) |
| U2 | 영속화 (common env path + atomic temp+rename 재사용 — `packages/process-shared/src/mcp-tool-grant-store.ts:121`; 공용 `atomicWriteJson` 헬퍼는 **미확인 → target**, 없으면 `rules/config.md`에 맞춰 신설) | 9개 상태(`queued`/`reserved`/`claimed`/`dispatched`/`resolved`/`failed`/`uncertain`/`paused`/`cancelled`) 저장 + **로드 실패 시 WARN + `.bak` 폴백**(`rules/config.md:11`,`:37`), 조용한 빈 큐 금지 | A1, A16 | 작성 중 · targeted green: helper 18 + store 66 · 미완결 |
| U3 | Enqueue 경로 (durable 먼저, UI 리시트 나중) | 상태 질문 포함 일반 후속 enqueue, auto-abort 없음, 원문·첨부 무변형, **idle이면 큐 우회 즉시 dispatch**하되 기존 `paused` 항목은 자동 재개 없음 | A1, A2, A14, A26, A27 | 작성 중 · Queue 블록 targeted green 23 · **host 와이어링·버튼 등록 미완** |
| U4 | Drain 경계 (adapter yield → CAS release → atomicClaim → fresh user dispatch) | `isUserInput` 재부여, author/text/files/context 보존 | A5, A7 | U4a 작성 중 · adapter targeted green 47 · U4b 미완결 |
| U5 | 우선순위 + 일시정지 (followup → autogoal, ASK/stop/error 시 pause) | 별도 `Goals` 레이블 유지 | A6, A8 | 작성 중 (host 유닛에 포함) · targeted 리시트 없음 |
| U6 | Send now | **abort보다 먼저 `reserved` 예약**(승자 1개) → **짧은 상태 뮤텍스를 teardown 전에 해제** → explicit interrupt → teardown await → **예약분 승격(재claim 없음)** → fresh dispatch. 선택 항목만, 부분 출력 `user-interrupted` 태그, 옛 턴 late write는 epoch으로 거절 | A9, A10, A11, A28, A30 | 작성 중 (interrupt/teardown 경로) · 위 2개 리시트에 미포함 |
| U7 | 경쟁·권한 (single winner, stale epoch reject, click-time canInterrupt + dispatch-time 인가) | 거부 시 항목은 같은 seq로 `queued` 잔류 + 사유 표시, paused와 구분, 클릭자가 작성자를 대체하지 않음 | A12, A13, A29, A30 | 작성 중 (액션 핸들러 RED 단계, 버튼 등록 미완) |
| U8 | 재시작/중단/삭제 복구 | 재시작: `queued`=paused, `reserved`=paused(미dispatch), `claimed`/`dispatched`=uncertain(블라인드 재실행 금지). stop/세션 종료: A31 분기대로 확정 + freeze 사유 표시. 세션 삭제: 비terminal 전 상태에서 가시적 취소 + 히스토리 | A16, A17, A18, A21, A31 | 작성 중 — host stop 와이어링 반영, shutdown/idle·adapter cancel·세션 마이그레이션 롤백 잔여 |
| U9 | 스레드 헤더 재설계 (단계 + 실제 마지막 활동 + Queue) | heartbeat/진행 분리, ETA 없음 | A19 | planned — surface 작업 진행 중, 실제 진행 신호 미배선 |
| U10 | 단일 진행 스트림 + 승인 경로 분리 | 중복 완료 카드·MCP 성공 스팸 제거, 승인은 분리된 컨트롤 경로, stop 명시 | A32, A33 | 작성 중 — 네이티브 task 렌더는 됐으나 **결과/피드백 단일 스트림 통합(B5) 미완결** |
| U11 | rendered-empty 가드 + legacy fallback | 첨부-only 허용 + 접근성 fallback, 미지원 환경에서도 Queue/Send now 유지 | A22, A23 | 작성 중 · targeted green: rendered-empty 15 + helper 41 · 미완결 |
| U12 | Liveness·outbox | 침묵 하드 abort 없음, 도구/승인 대기 구분, rate limit + 재시작 idempotency, 옛 턴 late write가 새 턴 표면을 덮지 않음 | A20, A24, A28 | 작성 중 — A24a surface-outbox-store 구현 중 **배선 없음** → A24 미성립 |
| U13 | 관측 지표 | 큐 depth·상태 전이 카운트·drain/interrupt latency·거절 사유별 카운트, 마지막 실제 진행 타임스탬프는 헤더와 같은 소스 | A34 | 작성 중 — host 배선(U13b) 구현 + targeted host 28건, **거절 경로·집계 미완 → A34 미종결** |
| U14 | Slack capability preflight (문서 → 실측) | **타입 표면 실측분**: 설치본(web-api 7.15.1 / types 2.20.1)에 task_card·plan·`task_update`/`plan_update`·`task_display_mode` 존재, `agents.*` lifecycle 부재 → 업그레이드는 Agent Sessions 채택 시에만 게이트(04 §4.3). **live 채택·렌더는 NOT TESTED.** red면 legacy fallback 유지. `agent_view`는 **인가 없음 → 검증·채택 제외** | A35 | 타입 표면 실측 / live NOT TESTED |
| U15 | 배포 target allowlist (프리뷰 한정) | `.github/workflows/deploy.yml:40-71`은 `:49`에서 채널 변수를 고르고 `:53-71`에서 **모든 줄을 필터 없이** 확장한다 → ① `PREVIEW_DEPLOY_TARGETS`·`PRODUCTION_DEPLOY_TARGETS`를 **읽기 전용**으로 열거 ② runner label ↔ 실제 host alias 대조로 work-m64 canonical+alias 확정 ③ **프리뷰 한정 per-run allowlist** 확정. ③이 워크플로/변수 변경을 요구하면 **별도 리뷰·승인 필수**. 미상 target = fail closed, 무필터 push 금지 | A25 | **blocked-by-user** — 유저 결정 "워크플로 변경 보류"(아래 §유저 결정). 읽기 전용 인벤토리 보고만 접수(alias 대조는 재검증 대상), 변경·배포 없음 |

**완료(`verified`)로 닫힌 유닛 = 0.** targeted 테스트 green은 유닛 완료가 아니며, host 와이어링·버튼 등록·
surface 작업이 남아 있다. U14는 타입 표면만 실측했고 live는 NOT TESTED. work-m64 제외는 아직 구현돼 있지 않다.

### 열린 명확화 — `turnEpoch` vs 항목 `epoch`

- 항목의 `epoch`은 **CAS 토큰**(항목 단위 경쟁 판정)이고, 세션의 `turnEpoch`은 **dispatch 세대 카운터**다.
  둘은 별개 필드이며 서로를 대체하지 않는다.
- `turnEpoch`은 **interrupt 이전, 예약(`reserved`) 시점에 올라간다** — 그래야 teardown 중 도착하는 옛 턴의
  지연 쓰기와 stale 버튼이 같은 기준으로 걸러진다(A12·A28이 같은 값을 쓴다는 SSOT §3.3 계약의 구현 형태).
- 스키마: `turnEpoch`은 **신설 필수 필드**이며 출하된 적이 없다 → **legacy 마이그레이션 없음**(추측 마이그레이션
  금지). 저장 스키마를 바꾸는 결정이므로 U1/U2 동시 수정이 필요하고, 비용은 스키마 편집이지 유저 데이터 이전이 아니다.
- 미결: 스키마 버전 필드를 함께 넣을지(04 §7 risk) — 결정 전까지 어느 유닛도 닫지 않는다.

### 커버리지 검사 (Acceptance ↔ 유닛)

```bash
# 출력이 비어 있어야 한다 = spec의 모든 A-ID가 유닛에 매핑되고, 유닛이 없는 A-ID를 참조하지 않는다
cd <repo> && comm -3 \
  <(rg -o '^\| (A[0-9]+) \|' -r '$1' .prd/04-slack-agent-ui-spec.md | sort -u) \
  <(rg -o '^\| U[0-9]+ \|.*' .prd/slack-agent-ui/loop.md | rg -o 'A[0-9]+' | sort -u)
```

의존: U1 → U2 → U3 → U4 → U5; U6 → U7은 U4 이후; U8은 U2 이후; U14는 U10 채택 전 선행;
U15는 어떤 배포보다 선행. U9–U12의 병렬 실행은 **주장하지 않는다** — 같은 표면 파일을 공유할 수 있고
파일 소유권(어느 유닛이 어느 파일을 고치는지)을 아직 검증하지 않았다. 착수 전 소유권 매핑이 선행 조건.

## 완결 절차 (rules/DEV.md §4 — 현재 임무의 정의된 끝)

1. 유닛별 TDD (RED 재현 → GREEN) + 위 6개 게이트 직접 재실행.
2. 외부 리뷰어 에이전트 경유(§2 delegation-first). 유닛당 1 디스패치(§3 per-unit).
3. 재발-결함 성격이면 RED-on-master 재현 고정.
4. CI green → 머지 → **프리뷰 배포(U15 allowlist 성립 후, work-m64 제외)** → 배포 후 실측.
5. 실제 Slack 스레드에서 Chrome로 화면 검증(Queue 표시, `Send now` 동작, 헤더 활동 시각) — 임무의 마지막 리시트.
6. prod 게이트는 유지 — 비가역 액션(prod 배포, `agent_view`)은 유저 승인 대상.

## 배포 안전 (U15 — 배포보다 선행)

- `deploy.yml:40-71`은 `:49`에서 채널 변수(`PREVIEW_DEPLOY_TARGETS` / `PRODUCTION_DEPLOY_TARGETS`)를 고르고
  `:53-71`에서 **모든 줄을 필터 없이** 확장한다 → "work-m64 제외"는 **미구현**. 구현됐다고 적지 않는다.
- 두 변수는 **읽기 전용**으로 열거만 한다. runner label ↔ host alias 대조로 canonical+alias를 확정한 뒤
  **프리뷰 한정** per-run allowlist를 만든다. 워크플로/변수 변경이 필요하면 **별도 리뷰·승인**.
- 미상 target = fail closed. 무필터 `main:deploy/dev` 또는 prod push 금지.

### 유저 결정 (2026-09-14) — 워크플로 변경 보류

- 물어본 것: per-run 프리뷰 target 선택 + dev 태그 보호를 위한 워크플로 변경 여부.
- **유저 선택: "워크플로 변경 보류".** 따라서 U15의 워크플로/변수 변경과 그에 딸린 **배포는 blocked-by-user**다.
- 우회 배포 경로는 **인가되지 않았다** — 다른 채널·수동 트리거·필터 없는 push 모두 금지. 대기가 정답이다.
- 이 결정은 **원 지시(구현 + work-m64 제외 배포)를 철회하지 않는다** — 배포 수단만 보류된 상태이고, SSOT §1 원문과
  현재 임무 정의는 그대로다.
- 보류 중에도 **로컬 구현·테스트는 계속한다**(게이트·targeted 리시트는 위 표 그대로 유지).

## 리뷰 상태

이원 리뷰에서 제기된 항목(안전한 턴 경계, drain 전 슬롯 release, durable 큐, 배포 target 선택)은
Spec/Arch에 반영했다. **기아 방지는 주장하지 않는다** — followup 우선은 사람 트래픽이 지속되면
autogoal을 설계상 미루는 동작이며, 유저 FIFO를 바꾸는 fairness 장치는 만들지 않는다.
**최종 리뷰 승인은 없다.**

## 라운드 로그

R1(문서 정합 복구) · R2(targeted 리시트) · R3(유저 "워크플로 변경 보류" 결정) · R4(통합 리시트 + 리시트 분리)
전문은 [`verification.md`](verification.md) §6에 있다.

### 유저 결정 (2026-09-15) — A32 결과·피드백 단일 스트림 = 답변 보존 방식

- 물어본 것: 결과·피드백을 스트림에 합칠 때 최종 소유 매핑을 "원 답변·결과·피드백 → 해당 턴의 보존되는
  스트림 메시지 하나"로 바꾸고, 통합 메시지에는 삭제 버튼 없이 본인 전용 피드백 접수 알림을 줄지.
- **유저 선택: "답변 보존 방식".** 기존 메시지는 삭제하지 않는다. 통합 스트림에는 dismiss 없음, 피드백 ack는
  ephemeral(원 답변 `chat.update` 덮어쓰기 금지), 스트림 ts는 completion tracker에 넣지 않는다.
- 기존 별도 완료 카드 경로(비통합)는 그대로 유지한다. 구현 seam은 `verification.md` §7에.

## 재개 위치 (2026-09-15 문서 커밋 시점 — 리드이지 진실이 아니다, 읽는 세션이 재검증한다)

- 코드 변경은 이 브랜치의 워크트리(`git worktree list`로 찾는다)에 **미커밋** 상태로만 있다. 이 문서 커밋은
  원장만 승격한 것이다. 워크트리 `git status`가 첫 검증이다.
- 문서 커밋 직전 워커 보고(각각 targeted 테스트만, 중앙 게이트 미실행): dispatcher round2 · surface-outbox-store(48)
  · thread-surface outbox 배선(A24b, 394) · host `prepareFollowupShutdown`/`cancelFollowupShutdownPreparation`
  + 중앙 admission 게이트(host 35) · `src/index.ts` prepare→clearAll 배선(계약 테스트 10). A24b 워커가
  `turn-surface.ts` TS2322 1건이 타 워커 red로 남아 있다고 보고했다 — 최종 트리 tsc는 아직 green이 아니다.
- 미구현: A32 통합 스트림(위 유저 결정대로), `message_not_found`에 대한 sent 인텐트 확정-삭제 API(A24b 워커 보고),
  A34 잔여 거절 경로·집계, adapter cancel/dispose의 coordinator 우회.
- 다음 순서: 최종 트리에서 build·tsc·test 재실행 → 유닛별 커밋 → 외부 리뷰 → CI → 머지. 배포·Chrome은 §배포 안전과
  verification.md §4의 차단 상태 그대로.
