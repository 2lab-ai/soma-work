---
name: zexplore
description: "Hardcore research orchestrator. Use when the user asks to deeply research a topic (architecture, libraries, prior art, trade-offs) before any plan or code. Triggered by: zexplore, 러서치, research, 조사, prior art, 선행 조사, 아키텍처 탐색."
---

# zexplore — Hardcore Research Orchestrator

zexplore는 **결론을 내기 전에 사실을 쌓는** 스킬이다. 의견·추측·"보통 이렇게 합니다"는 source로 금지.
출력은 **근거 있는 Research Brief 1건**이다. 코드 변경 0, PR 0.
이슈 생성·유저 승인·구현 디스패치는 caller(`local:z` or direct user) 책임. 이 스킬은 synthesis까지만 한다.

## When to use

- 유저가 "러서치해줘 / research / 조사해줘 / prior art 비교"라고 요청
- `local:z` phase1에서 계획 전에 사실 확인이 필요
- 모르는 라이브러리·프로토콜을 스펙·코드로 확정하기 전
- 후보 해법이 2개 이상이라 결정 입력이 필요

## When NOT to use

- 스펙이 확정된 구현 → `local:z` / `local:zwork`
- PR 리뷰/검증 → `local:zcheck`, `stv:verify`
- 구현-스펙 갭 점검 → `local:zfix`

## Definitions (SSOT)

- **Repo fact** — 이 또는 관련 레포의 코드·설정·커밋에 직접 있는 사실. 근거: `{path}:L{line}` 1개가 primary. 보강이 가능하면 commit/issue URL 1개 더.
- **External fact** — 외부 세계 사실(라이브러리 동작, 벤치마크, 프로토콜). 근거: **독립 출처 ≥2개**.
- **Inference** — 사실로부터 유도한 추론. 반드시 `(inference)` 라벨. caller에게 이건 저자의 해석이라고 명시.
- **Independent sources** — 같은 프로젝트의 README + docs는 **비독립**. 독립으로 인정: (a) official doc + 실제 소스코드(commit SHA permalink) / (b) official doc + 제3자 벤치마크·CVE·이슈 리포트 / (c) 서로 다른 조직이 publish한 문서. **LLM 출력은 source 금지**(evidence가 아니라 hypothesis generator).
- **Source admissibility** — GitHub issue/maintainer comment는 동작·제약·로드맵 claim에 허용. 성능 claim은 code/benchmark 동반 시만. 3rd-party benchmark는 methodology 공개 시 1차, 미공개 시 보조.
- **Exhausted search** — 후보 1개뿐일 때 필요: (a) 조사한 생태계 ≥3 (OSS / commercial SaaS / 내부) (b) keyword 변형 ≥5 (c) source family ≥3 (official docs / issues / benchmarks / academic / standards). 하나 누락 시 후보 ≥2로 회귀.

## Hard Rules (Deterministic gates)

이 체크리스트가 primary gate다. codex 점수는 보조 lint.

- [ ] Unsourced claim 0개 (모든 claim에 source 컬럼이 있다).
- [ ] External fact에 independent source ≥2.
- [ ] Repo fact에 `{path}:L{line}` ≥1.
- [ ] Inference 전부 `(inference)` 라벨.
- [ ] Claim ledger 표가 본문에 존재.
- [ ] Candidate option ≥2 (1개뿐이면 Definitions의 "exhausted search" 3조건 전부 충족 근거 명시).
- [ ] 평가 축 ≥5.
- [ ] Disconfirming Evidence ≥3 (각 항목에 likelihood H/M/L/Unknown + basis).
- [ ] Conflicted claim은 `status=conflicted`로 표기하고 Open Questions로 이관.
- [ ] Issue body derivable — Phase 3 아래 **Issue mapping 표**의 6행이 모두 채워짐.

## Process

### Phase 0: Charter

1. Research Question을 **한 문장**으로 재작성. 모호하면 `local:UIAskUserQuestion` — 연구 범위 확정 시 템플릿 [`../UIAskUserQuestion/templates/zexplore-research-scope.json`](../UIAskUserQuestion/templates/zexplore-research-scope.json) 사용. `{scope_summary}` / `{sources_list}` / `{depth_level}` / `{time_budget}` placeholder 채워 전송.
2. **평가 축 ≥5개** 선정(비용·지연·격리·OS 커버리지·락인·운영 부담·업스트림 생존성·마이그레이션 비용 중).
3. **Bounded scan plan** 수립: seed paths / keywords / 관련 API 이름 리스트 + **stop criteria**. 기본값: `depth ≤ 3 hops, files ≤ 30, time ≤ 20m`. caller가 override 가능. "전수 조사"라는 단어 사용 금지.

### Phase 1: Parallel Investigation (3 streams)

병렬 디스패치 — Agent tool 호출 한 메시지에 여러 서브에이전트 동시 호출(`superpowers:dispatching-parallel-agents` 패턴이 가용하면 사용):

- **A. Internal sweep** — `local:explore`로 seed 기반 스캔. 결과는 `{path}:L{line}` 리스트 + "이미 있음 / 부분 / 없음" 분류.
- **B. Prior art sweep** — `local:librarian`으로 외부 오픈소스·표준·관련 제품 조사. 후보별 (a) official doc URL + (b) source/commit permalink 또는 3rd-party benchmark/issue 최소 1쌍.
- **C. Deep reasoning (optional)** — 비용·지연 여유 있을 때만 `local:zdeepresearch` background 디스패치. 결과는 **hypothesis generator 전용** — Claim ledger의 source 컬럼에 기입 금지. C가 실패하거나 생략되면 A+B만으로 Brief 생성 가능, 단 **Decision Inputs의 confidence 상한은 M**.

### Phase 2: Cross-check & Contradiction Hunt

1. Claim ledger 채우기 (아래 템플릿).
2. **충돌 감지**: source A ≠ source B 시 `status=conflicted`로 적고 보류 근거.
3. **반증 라운드**: 현재 leading option에 대해 "무엇이 깨지면 이 선택이 틀렸는가" ≥3, 각 깨짐 조건의 likelihood를 **H/M/L/Unknown + basis**로.

### Phase 3: Synthesis — Research Brief 템플릿

```markdown
# Research: {Research Question}

## TL;DR
- 3줄 이하 요약 + leading candidate 1개 + 가장 큰 리스크 1개 (또는 "no recommendation yet" + 이유).

## Prior State (Internal)
- {repo}/{path}:L{line} — {요약}
- ...

## Candidates (Decision Inputs)
| Axis | Opt A | Opt B | Opt C | ... |
|------|-------|-------|-------|-----|
| Cost (upfront) |   |   |   |
| Cost (ongoing) |   |   |   |
| Latency p50/p95 |   |   |   |
| Isolation (proc/vm/host) |   |   |   |
| OS coverage |   |   |   |
| Vendor lock-in (L/M/H) |   |   |   |
| Ops burden (L/M/H) |   |   |   |
| Upstream health (maint/last release) |   |   |   |
| Migration cost (L/M/H) |   |   |   |

## Claim Ledger
| # | Claim | Type | Source A | Source B | Status |
|---|-------|------|----------|----------|--------|
| C1 | ... | repo fact | path:line | commit url | confirmed |
| C2 | ... | external fact | doc url | src permalink | confirmed |
| C3 | ... | inference | C1+C2 | — | open |
| C4 | ... | external fact | doc A | vendor B | conflicted |

## Surprises / Non-obvious findings
- ...

## Disconfirming Evidence (≥3)
- "{Opt X}가 틀렸다면, 조건 {…} — likelihood: H/M/L/Unknown; basis: {…}"

## Open Questions
- 질문 + 어떤 evidence가 나오면 해소되는가

## Decision Inputs (Recommendation optional)
- 추천이 있으면: `Recommend: Opt X` + confidence (H/M/L) + top-3 disconfirmers
- 근거 부족하면: `No recommendation — evidence gap: {…}`

## Next Actions (for caller)
- Issue 제목 초안 (caller가 쓸 수 있게)
- 필요한 PoC 1개 (caller 범위에 PoC가 있을 때만)
```

**Issue mapping 표 (caller가 이슈 본문 구성 시 참조):**

| Issue field | Source in Brief |
|-------------|-----------------|
| Title | Next Actions의 첫 항목 |
| Problem statement | TL;DR 1문장 + Prior State 요약 |
| Options | Candidates 비교표 |
| Evidence links | Claim Ledger Source A/B 열 |
| Open questions | Open Questions 섹션 |
| Next actions | Next Actions 섹션 |

### Phase 4: Two-gate Validation

1. **Primary gate — Hard Rules 체크리스트 전수**. 하나라도 실패 → 해당 Phase로 루프백.
2. **Secondary lint — codex score**. `mcp__llm__chat({ model:"codex", prompt:<보고서 + 체크리스트>, timeoutMs: 600000 })` 동기 호출로 결과 수거. 점수 <95면 피드백 수집해 Phase 2~3에 반영. 재리뷰 ≤3회. 후속 프롬프트가 필요하면 반환된 `sessionId`로 `mcp__llm__chat({ resumeSessionId, prompt })` 호출.
   - **Retry on timeout**: 10분 초과(`BACKEND_TIMEOUT`) 시 새 세션(`mcp__llm__chat` with `model`)으로 1회 재실행. 그래도 미완이면 lint 실패 기록.
   - **Primary 통과 시 lint 결과와 무관하게 Brief 반환**. lint 실패·3회 초과는 Brief에 "codex lint: skipped/failed — reason" 노트로 남기고 caller가 추가 검토 여부 결정(`local:UIAskUserQuestion`).

### Phase 5: Handoff

- Brief를 caller(또는 유저)에게 반환. **이슈 생성·유저 approve는 caller 책임**. zexplore는 여기서 끝난다.

## Operating Limits

- Phase 1-C background job: per-model timeout 10분. 1회 재실행(새 chat) 허용. 둘 다 실패해도 Brief는 A+B만으로 완성되어야 하며 Decision Inputs confidence 상한 M.
- Phase 4 codex lint: 3회 미만에 pass 못하면 lint 실패로 기록. Primary gate 통과 시 Brief 반환 계속. caller가 추가 검토를 결정.

**Authoring constraint (CI / review에서 체크):** SKILL.md ≤ 10KB (user-skill-store.ts 강제 한계). Headroom preferred. Runtime hard rule 아님.

## Anti-patterns

- "일반적으로는…" 출처 없이 서술 → Hard Rule 위반.
- LLM 출력을 ledger의 source로 기입 → 금지(hypothesis 전용).
- "전수 조사" 선언 → bounded scan + stop criteria로 대체.
- Brief에 판단 결과만 있고 disconfirmers 없음 → 미완성.
- Caller 역할 침범(유저 approve 직접 요청, 이슈 직접 생성) → 금지.
