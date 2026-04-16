---
name: zdeepresearch
description: "Background deep research worker. Dispatches long-form reasoning on a topic to codex and/or gemini and returns a structured brief. Use as Phase 1-C worker of local:zexplore or standalone for focused deep dives. Triggered by: zdeepresearch, 딥리서치, deep research."
---

# zdeepresearch — Background Deep Research Worker

zdeepresearch는 `local:zexplore`의 **워커**다. codex/gemini에게 백그라운드 롱폼 추론을 맡기고, **정규화 brief**를 돌려준다.  
raw 모델 출력은 artifact로 저장하고, 호출자에겐 **요약(정규화 brief)** 만 전달한다. 자체적으로 최종 판단은 내리지 않는다.

## When to use

- `local:zexplore` Phase 1-C — hypothesis generation이 필요할 때
- 특정 라이브러리/프로토콜/업계 관행을 한 모델에 시간을 주고 깊게 탐색
- codex + gemini에 동일 질문을 던져 답변 교차검증

## When NOT to use

- 단답 질의 → `mcp__llm__chat` 직접.
- 코드베이스 스캔 → `local:explore`.
- 외부 문서 수집 → `local:librarian`.
- 리서치 전체 오케스트레이션 → **`local:zexplore`를 쓴다**. 이 스킬은 부품.

## Input

```
Topic:        {한 문장 질문}
TaskClass:    {comparison | landscape | single-system-deep-dive}   # 기본 comparison
Depth:        {1500 | 5000 | 10000} words     # 기본 5000
Perspective:  {first-principles | failure-modes | cost-structure | security | prior-art-comparison}
Must-cover:   # 선택
Must-avoid:   # 선택
Models:       {codex | gemini | both}          # 기본 both
Budget:       {timeout_min (default 10), max_retry (default 1)}
```

## Definitions

- **Raw output** — 모델이 돌려준 원문. Phase 2에서 artifact 파일로 저장.
- **Normalized brief** — 호출자에게 반환하는 구조화 문서. **요약이 맞다.** 원문 복제가 아님.
- **Source line** — 모델이 인용한 URL 혹은 코드 경로. artifact에는 원문 보존, brief에는 dedup된 URL 목록.

## Process

### Phase 0: Prompt forging

아래 템플릿으로 **최소 800자** 시스템 프롬프트 생성. 짧으면 얕은 답이 돌아온다.
**모델에게 요청하는 raw 출력은 8섹션 구조** — 호출자에게 반환하는 Brief(10섹션)와 구분된다.

```
ROLE: Senior research analyst. No sycophancy. No fluff.
Be willing to say "I don't know" with reason.

QUESTION: {Topic}

OUTPUT REQUIREMENTS (8 sections; minimums branch by TaskClass):
- Length target: {Depth} words (±20%).
- Structure:
  1. Executive answer (≤5 bullets)
  2. First principles (must-hold regardless of implementation)
  3. Option space — TaskClass별 최소치:
     - comparison / landscape: ≥3 candidates with quantitative axes
     - single-system-deep-dive: ≥1 candidate (주제 시스템) + 필요 시 대체 후보. 대안이 없으면 "alternatives: N/A — justification" 명시.
  4. Failure modes for current leading option (≥5)
  5. Cost structure (upfront / ongoing / exit)
  6. Prior art table with source URLs — TaskClass별:
     - comparison / landscape: ≥5 rows
     - single-system-deep-dive: ≥3 rows (related projects, prior versions, dependencies). 불가능 시 "prior art: N/A allowed with reason".
  7. Open questions + what evidence would resolve them
  8. Recommendation ONLY if evidence warrants; else say so.
- Every numeric claim must cite URL or mark "(estimate, low confidence)".
- Every architectural claim must name ≥1 concrete system + URL that proves it works.

PERSPECTIVE LENS: {Perspective}

MUST-COVER: {list}
MUST-AVOID: {list}

RED-TEAM CLAUSE: End with "What would make this answer wrong?" —
list ≥3 concrete disconfirming observations.
```

### Phase 1: Background dispatch

- `Models = both` (default):
  - `mcp__llm__chat({ model:"codex", prompt:<forged>, background:true })` → jobA
  - `mcp__llm__chat({ model:"gemini", prompt:<forged>, background:true })` → jobB
- `Models` 단일: 한쪽만.
- **background:true 필수**. foreground 금지 (UI 블로킹 + timeout 리스크).

### Phase 2: Poll, collect, persist

- `mcp__llm__status({ jobId })` 30–60s 간격 폴링.
- 완료 → `mcp__llm__result({ jobId })`로 raw 수거.
- Budget.timeout_min 초과 → 1회 `mcp__llm__chat-reply`로 재촉 → 그래도 미완이면 실패 기록.
- **Artifact 저장**: 각 raw 출력을 파일로 보존.
  - 경로: `.claude/tasks/{sessionId}/zdeepresearch/{topic-slug}__{model}.raw.md`
  - 프롬프트도 같이 저장: `…__prompt.md`
  - 저장 실패해도 brief 반환은 계속(artifact는 선택적).

### Phase 3: Normalize → Brief

두 모델 raw를 **요약 병합**하여 호출자에게 반환. (raw는 artifact로만 존재.)
**반환 Brief는 정확히 10섹션** (아래 순서대로, 섹션 수는 Hard Rules와 일치해야 함).

```markdown
## Deep Research Brief — {Topic}

### 1. Models run
- codex: completed/failed/timeout
- gemini: completed/failed/timeout
- artifacts: {path to raw files}

### 2. Converged (both models agree, claim level)
- ...

### 3. Divergent (models disagree)
| Point | codex position | gemini position | traceability / recency / evidence density (not "which is right") |
|-------|----------------|-----------------|------------------------------------------------------------------|

### 4. Unique to codex
- ...

### 5. Unique to gemini
- ...

### 6. Option table (union, deduplicated)
| Option | Cost (upfront/ongoing) | Latency | Isolation | OS | Lock-in | Notes | Cited by |
|--------|-----------------------|---------|-----------|----|---------|-------|----------|

### 7. Failure modes (union, deduplicated)
- ...

### 8. Open questions (union, deduplicated)
- ...

### 9. Sources (dedup across both, URL full)
- https://...
- ...

### 10. Models' recommendation (isolated; NOT zdeepresearch's judgment)
- codex: ...
- gemini: ...
```

### Phase 4: Return to caller

Brief를 반환. caller(`local:zexplore` Phase 1-C 혹은 유저)는 이 brief를 hypothesis generator 재료로 쓴다.
- Brief에 있는 사실을 zexplore Claim Ledger의 source로 넣지 말 것 (LLM 출력은 source 금지 원칙).
- URL은 그대로 follow-up 가능한 후보. Ledger의 독립 출처로는 **원문 URL을 실제로 확인한 경우에만** 채택.

## Hard Rules (Deterministic gates)

- [ ] 최소 1개 모델 결과 존재 → brief 반환 가능.
- [ ] 둘 다 실패 → **failure report** 반환 (원인, 타임아웃·오류 로그, artifact 경로).
- [ ] Brief에 10섹션 전부 존재: `Models run / Converged / Divergent / Unique to codex / Unique to gemini / Option table / Failure modes / Open questions / Sources / Models' recommendation`.
- [ ] Divergent 표의 비교 열은 `traceability / recency / evidence density`로 한정 — 모델 정답 판정 금지.
- [ ] URL은 원문(truncation 금지).
- [ ] `zdeepresearch recommends…` 같은 독자 판단 문장 0개.

## Operating Limits

- 모델별 timeout 10분(기본). timeout 시 동일 모델로 새 `mcp__llm__chat` 1회 재실행. 그래도 미완이면 failure로 기록하고 계속 진행.
- **Degraded mode**: `Models=both`로 요청됐지만 한쪽만 성공 시 brief의 `Divergent`/`Unique to {failed}`는 "(failed — no data)"로 명시 후 진행. caller(zexplore)는 Decision Inputs confidence 상한 M 적용.
- artifact 경로 기록 실패는 non-fatal.

**Authoring constraint:** SKILL.md ≤ 10KB. 목표 <9KB. Runtime hard rule 아님(CI/review에서 체크).

## Anti-patterns

- `background:false` → 금지.
- `Models=both`인데 한 모델만 돌리고 양쪽 실행했다고 보고 → 금지.
- raw 원문을 그대로 caller에게 dump → 금지. 정규화 필수.
- 프롬프트 500자 이하 → 얕은 답 유발, 재작성.
- LLM 추천 문장을 Brief의 header에 노출 → `Models' recommendation` 섹션 안으로 격리.
