---
name: trinity
description: "Use when a brief (code review, plan review, decision, tie-break) needs the 3-engine consensus panel run until unanimous — the PRIMARY vehicle for every review/consult gate that previously called mcp__llm__chat model:codex directly (z phase1 plan review, zwork RED-coverage review, zreflect evaluation, zexplore secondary lint, autoz Rule 1(b) consults + Rule 8 review gate, oracle-reviewer). Triggers on 'trinity', '트리니티', '3엔진 합의', 'trinity로 리뷰/판단해줘'. Args — the brief to adjudicate (required; text, file path, or PR/diff reference); optional --max-rounds N (default 5). Degrades via the Fallback chain (llm_chat codex → codex-fallback opus), never by silently skipping the gate."
---

# trinity — 3-engine consensus loop

같은 브리프를 서로 다른 엔진 3개에 병렬로 주고, **전원 합의(unanimous)** 까지 상호 반박 라운드를 돈다. 최대 라운드 도달 시 분열 보고로 종결 — dispatcher가 조용히 승자를 고르지 않는다.

기존에 `mcp__llm__chat model:codex` 단일 엔진으로 돌던 모든 리뷰·자문 게이트의 **primary**가 이 스킬이다. codex 단일 호출은 이제 이 스킬의 fallback1이다 (§Fallback chain).

## Panel (고정 로스터)

| 슬롯 | 에이전트 | 엔진 |
|---|---|---|
| physics-first | `grok45-elon` | grok-4.5 (llmux 경유) |
| 책사 | `gpt56-zhuge` | gpt-5.6-sol (llmux 경유) |
| 합성 전략가 | `strategist` | anthropic (model 미지정 → 세션 상속) |

세 엔진이 서로 달라야 의미가 있다 — 로스터 교체는 유저 지시가 있을 때만. **엔진 대체 금지**: 한 엔진이라도 불능이면 그 라운드의 패널은 성립하지 않은 것이고(2-엔진 결과를 primary 합의로 세지 않는다), §Fallback chain의 fallback1로 강등한다. (`gpt56-elon`은 단독 자문용 에이전트다 — 패널 대타가 아니다.)

## Protocol

### 0. 브리프를 self-contained로 만든다 (dispatcher 작업)

패널리스트가 스스로 조사할 수 있다고 가정하지 마라 — 서브에이전트의 툴 예산은 제한적이다. 디스패치 전에 dispatcher가 증거를 선확보해 브리프에 **인라인**한다:

- 코드/PR 리뷰 → diff·핵심 파일 발췌를 파일로 덤프하고 절대경로 + 요지 인라인
- 결정/전략 → 결정 질문, 실측 제약(비용·수치·마감), 선택지 목록을 본문에 직접
- 유저 원문은 항상 verbatim 포함 (의역 금지)
- 코드 리뷰 브리프는 `local:oracle-reviewer`의 리뷰 가이드라인(버그 판정 기준·finding 형식)을 재사용해도 좋다 — 단 출력 계약은 아래 형식이 우선.

브리프 첫머리에 **패널리스트 격리 계약**을 강제한다 (fan-out 위생 — 2026-07-15 재귀 미니-trinity 재발):

```
너는 trinity 패널리스트 1인이다. 다른 에이전트·패널·스킬을 스폰하지 마라.
합의는 dispatcher가 라운드로 만든다 — 네 안에서 합의를 시뮬레이션하지 마라.
주어진 증거만으로 네 단독 판정을 내라.
```

브리프 말미에 **답변 계약**을 강제한다:

```
반드시 이 형식으로 끝내라:
VERDICT: <APPROVE | REJECT | 선택지-이름 | 한 줄 결론>
MUST-FIX: <차단 항목 목록, 없으면 "none">
근거: <핵심 근거 3개 이내, 증거 위치 포함>
```

### 1. Round 1 — 병렬 디스패치

한 메시지에 Agent/Task 3콜 (`grok45-elon` / `gpt56-zhuge` / `strategist`), 동일 브리프, background 실행. 셋 다 도착할 때까지 대기. dispatcher는 자기 의견을 브리프에 싣지 않는다 — 중재자다.

### 2. 합의 판정 (기계적)

**합의 = ①세 VERDICT의 top-line이 동일 AND ②미해소 MUST-FIX 0.**
근거·톤 차이는 불합의가 아니다. VERDICT가 하나라도 다르거나, 누군가의 MUST-FIX를 나머지가 수용도 반박도 안 했으면 불합의.

### 3. Round 2..N — 상호 반박

불합의면 **같은 세 에이전트**(컨텍스트 유지, SendMessage/resume)에 나머지 두 명의 입장 전문을 엔진 라벨과 함께 전달:

```
다른 두 패널리스트의 입장이다 (라벨: 엔진명).
[grok-4.5] ... / [gpt-5.6-sol] ... (전문)
각 논점에 대해 반박하거나 네 입장을 갱신하라. 동의로 바꾸면 무엇이 설득했는지 명시.
동일한 VERDICT/MUST-FIX/근거 형식으로 끝내라.
```

전달은 무편집 전문 — dispatcher가 요약·논평을 끼워넣지 않는다. 라운드마다 §2 판정 반복.

### 4. 종결

- **합의 도달** → 즉시 종료. 라운드를 채우려고 더 돌지 않는다.
- **max-rounds(기본 5; 자율 파이프라인에서는 하드캡 5) 도달 + 불합의** → 분열 보고: 갈린 축, 에이전트별 최종 VERDICT + 핵심 근거, 라운드별 입장 변화 1줄씩. 결정은 caller/유저에게 — dispatcher 캐스팅보트 금지.
- **자율 caller(유저에게 물을 수 없는 파이프라인, 예: autoz)의 분열 터미널**: 분열은 fallback 사유가 아니다(패널은 성립했다). caller는 전 패널리스트 MUST-FIX의 합집합을 blocking findings로 간주해 수리 후 게이트를 1회 재실행한다; 재실행도 분열이면 Hard Blocker — 분열 축을 보고하고 정지한다 (approve 금지, 질문 금지).

### 5. 최종 보고 형식

```
## trinity: <브리프 한 줄>
- 결과: 합의 (round K/N) | 분열 | DEGRADED(fallback1|fallback2)
- 합의문: <VERDICT + 통합 MUST-FIX>   ← 합의 시
- 분열 축: <무엇에서 갈렸나>            ← 분열 시
- 패널: [grok-4.5] V / [gpt-5.6-sol] V / [anthropic] V
- 라운드 로그: R1 3-way split → R2 2:1 → R3 unanimous
```

## Fallback chain (게이트는 절대 조용히 스킵되지 않는다)

비-anthropic 엔진은 llmux를 경유한다 — llmux 데몬 다운/모델 미노출이면 패널이 성립하지 않을 수 있다. 강등 순서는 고정이며, 어느 tier가 판정을 냈는지 **반드시 산출물(PR body·리포트)에 기록**한다:

1. **Primary — trinity 패널.** 패널리스트 하나가 죽거나 형식 위반이면 같은 라운드에서 1회 재요청. 그래도 3-엔진 패널이 성립 불가(예: llmux 다운으로 grok·gpt 둘 다 불능)면 ↓
   `⚠️ TRINITY DEGRADED → fallback1 llm_chat(codex) — <이유>` 를 가시 출력하고 강등.
2. **Fallback1 — `mcp__llm__chat` `model: codex` 단일 엔진.** 동일 브리프 + 동일 답변 계약 (브리프가 점수 등 추가 필드를 요구하면 fallback tier도 그 필드를 반드시 포함한다 — pass/fail 판정 기준은 tier와 무관하게 caller 브리프가 정의한 하나여야 한다). 장기 실행이면 `local:llm-dispatch` 프로토콜로 구동. 사용/쿼터 소진·API 에러·타임아웃·빈 출력이면 1회 회복 재시도 후 ↓
   `⚠️ TRINITY DEGRADED → fallback2 codex-fallback(opus) — <이유>` 를 가시 출력하고 강등.
3. **Fallback2 — `codex-fallback` opus 서브에이전트 (자동).** 동일 브리프 전달, 판정은 `trinity-fallback2 (opus)` 라벨로 기록. 이 tier는 자동이다 — 유저 승인 게이트가 아니다 (2026-07-16 지시로 기존 opt-in 계약 대체).
4. **Fallback2까지 실패** → 게이트 미충족. 진행 중단하고 caller/유저에 보고. 리뷰 없는 approve/merge/deploy는 어떤 tier에서도 금지.

## Guardrails

- 라운드 간 브리프 본문 변경 금지 — 새 증거가 필요해지면 dispatcher가 확보해 "추가 증거" 블록으로만 append.
- 이 스킬의 산출은 판단/리뷰다 — 합의 결과의 실행(코드 수정·머지·배포)은 caller의 몫.
- 강등 사유를 지어내서 fallback으로 도망가지 마라 — primary 실패의 원문 에러를 강등 경고에 포함한다.
- 패널리스트가 서브에이전트/스킬을 스폰한 흔적이 보이면 그 응답은 무효 — 같은 라운드에서 격리 계약을 재강조해 1회 재요청.

## Call sites (이 체인을 쓰는 게이트)

| Caller | 게이트 |
|---|---|
| `local:z` phase1 step 4 | 계획 리뷰 |
| `local:zwork` step 2 | RED 테스트 커버리지 리뷰 |
| `local:zreflect` step 5 | 자기반성 평가 |
| `local:zexplore` Phase 4 | secondary lint |
| `local:autoz` Rule 1(b) | SSOT-shaping 자문 (trivial-skip 유지) |
| `local:autoz` Rule 8 | **머지 전 필수 코드리뷰 게이트** |
| `local:oracle-reviewer` | 코드 리뷰 커맨드 |
| `local:explore-unknowns` Stage 2/4 | 영토가 침묵할 때의 bounded consult |
