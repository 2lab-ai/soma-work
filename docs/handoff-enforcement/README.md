# Epic #694 유저 가이드 — z 세션 핸드오프, 이제 "말"이 아닌 "구조"로 강제됨

> 대상: `$z <이슈>` 흐름을 쓰는 유저 / 팀.
> 범위: 에픽 [#694](https://github.com/2lab-ai/soma-work/issues/694)에서 머지된 4개 가드의 사후 설명 가이드. 구조적 의도와 유저 체감 동작을 한 페이지에 정리.
> 참고 문서: 세부 spec/trace는 `docs/handoff-entrypoints/`, `docs/pr-issue-precondition/`, `docs/handoff-budget/`, `docs/dispatch-safe-stop/`에 각 서브이슈별로 존재. 계약 자체는 `src/local/skills/using-z/SKILL.md` §Session Handoff Protocol이 단일 진실원.

## 📌 한 줄

유저가 `$z <이슈>` 한 번 치면 Claude 세션이 **계획 세션 → 구현 세션 → 에픽 업데이트 세션**으로 스스로 넘어가는데, 그 넘어가는 이음매 4곳에서 **모델이 헛짓하면 호스트가 즉시 차단**하도록 고친 것.

## 왜 만들었나 — 어떤 UX 사고를 막으려는가

`z` 컨트롤러는 원래 한 세션 안에서 phase0(clarify) → phase1(plan) → phase2(구현) → phase5(에픽 업데이트)를 다 돌렸다. 문제는:

- 계획 단계 잡음 + 구현 잡음 + 에픽 요약이 한 컨텍스트에 누적 → 캐시 drift, "지금 뭐 하고 있었지?" 재구성 비용
- 에픽 상위 view에 서브이슈 N개 구현 잡음까지 쌓임

그래서 [#693](https://github.com/2lab-ai/soma-work/issues/693)에서 phase 경계마다 **세션을 자르는 프로토콜**(Session Handoff)을 문서로 정의. 근데 문서만 두면 모델이 규율을 어기는 순간 바로 드리프트. 실제로 코덱스 리뷰(74/100)가 식별한 구멍 4개:

1. 새 세션이 핸드오프 진입점에 **결정적으로** 들어가는지 호스트가 보장 못 함 — 프롬프트 분류기 추론에 의존
2. PR 생성 경로가 **연결 이슈 존재**를 호스트 레벨에서 안 봄 → 모델이 규율 어기면 orphan PR
3. Continuation 루프에 **깊이 제한이 없어 자동 재귀 무한 루프**가 구조적으로 가능
4. 핸드오프 dispatch가 실패하면 **default 세션으로 조용히 표류** — 유저는 뭐가 잘못됐는지 모름

문서가 아니라 호스트가 강제해야 진짜 차단된다. 그게 이 에픽.

## 무엇을 만들었나 — 4개 가드

### 가드 1. 결정적 핸드오프 진입점 ([#695](https://github.com/2lab-ai/soma-work/issues/695) → [PR #703](https://github.com/2lab-ai/soma-work/pull/703))

**Before**: 새 세션이 프롬프트에 `<z-handoff>` 블록이 있는지 모델이 알아서 읽고 phase 분기.
**After**: `WorkflowType`에 `z-plan-to-work` / `z-epic-update` 두 값 추가. 호스트가 `<z-handoff>` 블록을 **파싱해서** 타입드 메타데이터(`HandoffContext`)로 세션에 저장. 블록이 없거나 망가져 있으면 `HandoffAbortError` → 한글 safe-stop 메시지 출력 + 세션 종료. 조용한 drift 불가능.

**유저가 보는 차이**: 에이전트가 "어라 뭐 하던 거지?"로 엉뚱한 phase로 가는 일이 없다.

### 가드 2. orphan PR 차단 ([#696](https://github.com/2lab-ai/soma-work/issues/696) → [PR #706](https://github.com/2lab-ai/soma-work/pull/706))

**Before**: 모델이 규율 어기고 이슈 없이 PR 만들면 그대로 통과.
**After**: `src/hooks/pr-issue-guard.ts`가 **PreToolUse 훅**으로 `gh pr create`와 `mcp__github__create_pull_request` 둘 다 가로챔. 연결된 이슈가 없고 Case A escape(tiny/small + 유저가 이슈 요구 안 함 + 레포 정책이 이슈-필수 아님)도 통과 못 한 상태면 **PR 생성 API 호출 전에 거부**.

**유저가 보는 차이**: "이슈 먼저 만들어줘"라고 했는데 에이전트가 PR만 턱 하니 올리는 사고가 구조적으로 불가능.

### 가드 3. 핸드오프 예산 1회 ([#697](https://github.com/2lab-ai/soma-work/issues/697) → [PR #713](https://github.com/2lab-ai/soma-work/pull/713))

**Before**: 모델이 실수로 한 세션 안에서 핸드오프를 두 번 발행하면 무한 루프 가능.
**After**: 모든 세션에 `autoHandoffBudget = 1`. `slack-handler.onResetSession`이 예산 체크 + 감소 후에야 reset 허용. 고갈되면 `HandoffBudgetExhaustedError` throw → Slack에 원인 메시지 출력, 세션은 살려둠(유저가 `$z <url>`로 수동 재진입 가능). 핸드오프로 시작된 **새 세션은 독립 예산 1회**를 다시 가짐 — 즉 구현 세션이 에픽 업데이트 세션으로 넘어가는 정상 체인(2-hop)은 통과, 3-hop은 차단.

**유저가 보는 차이**: 봇이 혼자 계속 새 세션 열면서 토큰 태우는 사고가 구조적으로 막힘.

### 가드 4. dispatch 실패 시 safe-stop ([#698](https://github.com/2lab-ai/soma-work/issues/698) → [PR #721](https://github.com/2lab-ai/soma-work/pull/721))

**Before**: forced workflow(`z-plan-to-work` 같은 거)가 dispatch 실패하면 조용히 default 세션으로 떨어져서 유저는 뭐가 꼬인지 모름.
**After**: `session-initializer`의 4개 drift 지점(classifier catch, in-flight timeout, forceWorkflow 전환 실패 × 2)에서 `handoffContext`가 있으면 `DispatchAbortError` throw. `slack-handler`가 이걸 받아서 **"무슨 워크플로 시도했고, 원본 이슈·에픽·체인ID가 뭐였고, 어떻게 재시도하면 되는지"**를 유저에게 명시적으로 띄움. 일반 Slack 메시지(핸드오프 아님)는 기존처럼 default 진입 — 호환성 유지.

**유저가 보는 차이**: 에이전트가 고장 나면 "고장났습니다, 이렇게 다시 치세요"라고 말해줌. 말없이 엉뚱한 세션으로 떨어지지 않음.

## 전체 흐름 한 장

```
유저: $z https://github.com/.../issues/42
│
├─ [세션 1 — 계획]  z phase0 ~ phase1
│     clarify → tier 판정 → Case A/B/C 라우팅 → plan 승인 → 이슈 생성
│     ↓ Handoff #1 (<z-handoff type="plan-to-work">)
│     ↓ 🛡 가드 1: 호스트가 sentinel 파싱 + HandoffContext 저장, 망가졌으면 safe-stop
│     ↓ 🛡 가드 3: 이 세션은 예산 1회 소진
│
├─ [세션 2 — 구현]  z phase2 (zwork)
│     새 예산 1회로 시작. 코드 작성 → 🛡 가드 2: PR 만들 때 연결 이슈 검증 → 머지
│     ↓ Handoff #2 (<z-handoff type="work-complete">, 서브이슈인 경우만)
│     ↓ 🛡 가드 4: dispatch 실패하면 default drift 없이 safe-stop + 재시도 힌트
│
└─ [세션 3 — 에픽 업데이트]  z phase5.E
      에픽 코멘트 + 체크리스트 체크 + 모두 완료면 에픽 close
      ※ 다음 서브이슈로 자동 체인 금지 — 유저가 직접 $z 입력
```

## 유저가 실제로 마주칠 에러 메시지

에이전트가 규율 어기면 이제 이런 Slack 메시지들이 뜸:

| 상황 | 메시지 종류 |
|---|---|
| `<z-handoff>` 블록 누락/망가짐 | `HandoffAbortError` — "핸드오프 sentinel 파싱 실패, 이슈 URL 확인 후 재시도" |
| 이슈 없이 PR 생성 시도 | PR 생성 자체가 막힘, "연결 이슈 없음, Case A escape 조건 미충족" |
| 같은 세션에서 두 번째 자동 핸드오프 시도 | `HandoffBudgetExhaustedError` — "예산 고갈, `$z <url>`로 수동 재입력" |
| forced workflow dispatch 실패 | `DispatchAbortError` — "원본 이슈/에픽/체인ID + 재시도 명령 힌트" 포함 패널 |

## 호환성 — 기존 사용자는 뭐가 바뀌나

거의 없다. 전부 **additive** 변경이다.

- 기존 10개 `WorkflowType`은 그대로 동작
- `<z-handoff>`가 없는 평범한 Slack 메시지 → 예전처럼 default classifier 경로
- 서명 깨진 함수: `ClaudeHandler.transitionToMain` 리턴 타입이 `void → boolean`. 기존 호출자는 리턴 무시해도 됨
- bypass 모드도 여전히 안전 (SDK precedence가 `deny > allow`)

즉 유저 입장에서는 **"에이전트가 더 똑똑하게 고장 나고, 조용히 엉뚱한 짓 하지 않음"** 정도.

## 솔직한 평가 — 정말 바이브코딩인가

아키텍처 자체는 **정답**이다. "프롬프트 컨벤션 → 호스트 강제"로 옮기는 건 당연히 해야 하는 리팩터. 4개 가드도 각자 단순하고 사이드이펙트 최소.

"바이브코딩" 느낌의 실체는 **의식(ritual)의 과잉**:

- PR마다 `docs/<subissue>/spec.md` + `trace.md` + 12개 AD + 코덱스 리뷰 v1/v2/v3
- 각 가드마다 전용 에러 클래스(`HandoffAbortError`, `HandoffBudgetExhaustedError`, `DispatchAbortError`)
- 테스트 45 + 18 + 16 개 등 총 70+ 개 추가, 한 가드당 평균 20개
- PR 본문이 AI 특유의 "AD-5.5 widened catch scope so Sites B/D..." 톤

이건 봇이 봇을 관리하는 계층이라 자기대화 밀도가 높을 수밖에 없는 구조적 현상이기도 하고, 동시에 **"이 정도 작업을 4개 PR로 쪼개고 각각 spec/trace까지 쓴 건 과함"** 이란 비판도 맞다. 같은 결과를 PR 1~2개 + 테스트 20개로 끝낼 수 있었음.

다만 **결과물 자체는 불량 없음**: codex 리뷰 96~97/100, P0/P1/P2 0건, 191개 테스트 통과, 백워드 호환 유지. 유저 UX 관점에서는 조용한 drift가 사라진 **순수 이득**.

## 소스 참고

- 계약: `src/local/skills/using-z/SKILL.md` §Session Handoff Protocol (단일 진실원)
- 가드 1: `somalib/model-commands/handoff-parser.ts`, `src/slack/pipeline/session-initializer.ts`
- 가드 2: `src/hooks/pr-issue-guard.ts` (PreToolUse SDK 훅)
- 가드 3: `src/slack/handoff-budget.ts`, `src/slack-handler.ts` `onResetSession`
- 가드 4: `src/slack/dispatch-abort.ts`, `src/slack/pipeline/session-initializer.ts` 4개 drift site
