---
name: zthink
description: "Pre-code deliberation discipline. Reduces common LLM coding mistakes by forcing assumption surfacing, scope control, and goal verification before edits. Triggered by: zthink, 생각, 고민, think before coding, 코드 짜기 전에, deliberate, sanity check."
---

# zthink — Think Before Coding

zthink는 **코드를 건드리기 전의 멈춤 게이트**다. 가정을 표면화하고, 불필요한 범위를 잘라내고, "성공"이 무엇인지 검증 가능한 형태로 고정한다.
출력은 **Intent Memo 1건** (또는 명시적 clarification 질문). 코드 변경 0, PR 0.
구현·이슈 생성·리뷰는 caller(`local:z` / `local:zwork`) 책임.

## When to use

- 유저 요청이 모호하거나 해석이 2개 이상
- `local:z` phase1 직전, 계획 전 가정 정리
- 수정 범위가 커 보이지만 정말 필요한지 확신 없을 때
- "간단해 보이는" 요청에 의심이 들 때 (대개 숨은 복잡성이 있다)
- Trivial task는 skip — 판단은 엔지니어링 감각

## When NOT to use

- 이미 명확한 단일 파일 수정 → 바로 구현
- 리서치 필요 → `local:zexplore`
- 구현-스펙 갭 점검 → `local:zfix`
- PR 검증 → `local:zcheck`
- 이전 지시에 대한 재지시(reinstruction) → `local:zreflect` 먼저

## Tradeoff

**속도보다 신중함을 우선.** 단, trivial task는 판단으로 skip.

## Process

### Phase 1: Think Before Coding

**가정하지 말고, 혼란을 숨기지 말고, 트레이드오프를 표면화한다.**

구현 전:
- 가정은 명시적으로 진술한다. 불확실하면 질문한다.
- 해석이 여러 개면 침묵으로 고르지 말고 나열한다.
- 더 단순한 접근이 있으면 말한다. 필요하면 push back.
- 불명확하면 멈추고, 무엇이 불명확한지 설명한 뒤 묻는다.

불명확 시 `local:UIAskUserQuestion`으로 확인. 가능한 해석 옵션으로 나열.

### Phase 2: Simplicity First

**문제를 푸는 최소 코드. 투기적 코드 금지.**

- 요청 범위 밖 기능 추가 금지.
- 일회성 사용 위한 추상화 금지.
- 요청되지 않은 flexibility/configurability 금지.
- 일어날 수 없는 시나리오에 대한 error handling 금지.
- 200줄이 50줄로 대체 가능하면 재작성.

자문: *"시니어 엔지니어가 이걸 overcomplicated라 부를까?"* → yes면 simplify.

### Phase 3: Surgical Changes

**필요한 것만 바꾸고, 네가 만든 것만 치운다.**

기존 코드 편집 시:
- 인접 코드·주석·포매팅 "개선" 금지.
- 깨지지 않은 코드 리팩터 금지.
- 네가 다르게 쓰고 싶어도 기존 스타일에 맞춘다.
- 관련 없는 dead code 발견 시 언급만. 삭제 금지.

네 변경이 orphan을 만들면:
- 쓰임 잃은 import/변수/함수는 제거.
- 기존부터 있던 dead code는 요청 없으면 제거 금지.

범위 테스트: *모든 변경 라인이 유저 요청에 직접 매핑되는가?*

### Phase 4: Goal-Driven Execution

**성공 기준을 정의하고 검증한다.**

각 태스크를 verifiable goal로 전환:
- "validation 추가" → "invalid 입력에 대한 테스트 작성 → 통과시킨다."
- "버그 수정" → "버그를 재현하는 테스트 작성 → 통과시킨다."
- "X 리팩터" → "테스트가 전후 모두 통과함을 보장."

다단계 태스크는 간단한 plan 제시:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

## Output: Intent Memo

caller에게 반환하는 포맷:

```markdown
## Intent Memo — {한 문장 재진술}

### Assumptions (explicit)
- ...

### Interpretations considered
- Opt A: ...
- Opt B: ...
- Chosen: {A/B} — reason
  (또는 "Unresolved — asking user")

### Scope boundary
- In: ...
- Out (explicitly): ...

### Success criteria (verifiable)
1. {check 1}
2. {check 2}

### Plan (if multi-step)
1. [Step] → verify: [check]
2. ...

### Simpler alternative considered
- {alt} — rejected because: ... (또는 "none — current is already minimal")
```

## Hard Rules

- [ ] 모든 숨은 가정이 Assumptions에 있다.
- [ ] 해석이 1개뿐이면 그 이유 명시. 2개 이상이면 선택 근거 또는 유저 질문.
- [ ] Scope의 Out 목록이 1개 이상 (범위 밖 유혹을 기록).
- [ ] Success criteria가 verifiable (관측 가능한 조건).
- [ ] "더 단순한 대안"을 고려했다는 증거 존재 (rejected reason 포함).

## Anti-patterns

- "보통 이렇게 합니다" → 가정을 숨긴다. Assumptions에 적는다.
- 요청 밖 "이왕이면" 리팩터 → Surgical Changes 위반.
- "혹시 모르니" 에러 핸들링 → Simplicity First 위반.
- Success criteria 없이 구현 착수 → Goal-Driven 위반.
- 해석 애매한 채로 조용히 한쪽 선택 → Phase 1 위반.
