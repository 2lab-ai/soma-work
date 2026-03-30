---
description: Send user-choice questions through model-command tool (fallback: structured JSON)
allowed-tools: Read, Grep, Glob, mcp__model-command__list, mcp__model-command__run
---

# UIAskUserQuestion - Structured User Choice Interface

When your turn ends and user input is required, use model-command tool first.

## Pre-requisite: Decision Gate

**질문을 만들기 전에 반드시 `decision-gate` Skill을 참조하여:**

1. 해당 결정의 switching cost tier를 예측한다
2. tier < small이면 → 자율 판단 (3명 다수결). **이 스킬을 사용하지 않는다.**
3. tier >= medium이면 → 이 스킬로 유저에게 질문한다

**자율 판단할 수 있는 걸 유저에게 물어보지 마라.** 유저의 시간을 낭비하는 것이다.

## Primary Action (Tool-first)

Call:

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice",
      "question": "[medium ~50줄] Your question with tier prefix",
      "choices": [
        { "id": "1", "label": "Option A (추천 2/3)", "description": "Tradeoff of A" },
        { "id": "2", "label": "Option B", "description": "Tradeoff of B" }
      ]
    }
  }
}
```

- Use `mcp__model-command__run` with the payload above.
- Use `mcp__model-command__list` first if command availability is unclear.

## Fallback Output (Only if tool unavailable)

If model-command tool is unavailable, output structured JSON so users can respond by number.

## Output Format

When a concrete technical decision is needed, output a `UserChoiceGroup`:

```json
{
  "type": "user_choice_group",
  "question": "Overall context question",
  "context": "Why these decisions are needed",
  "choices": [
    {
      "type": "user_choice",
      "question": "[tier ~N줄] Specific technical question",
      "context": "Why this decision matters",
      "options": [
        { "id": "1", "label": "Option A (추천 2/3)", "description": "Tradeoffs of A" },
        { "id": "2", "label": "Option B", "description": "Tradeoffs of B" }
      ]
    }
  ]
}
```

## TypeScript Interfaces

```typescript
interface UserChoice {
  type: 'user_choice';
  question: string;              // "[tier ~N줄] Specific technical question"
  options: UserChoiceOption[];   // 2-4 actionable options (Slack UI button limit)
  context?: string;              // Why this decision is needed
}

interface UserChoiceOption {
  id: string;           // "1", "2", etc.
  label: string;        // Concrete action + review consensus (e.g., "Fix (추천 2/3)")
  description?: string; // Tradeoffs of this choice
}

interface UserChoiceGroup {
  type: 'user_choice_group';
  question: string;              // Context for all choices
  choices: UserChoice[];
  context?: string;              // Why these decisions are needed
}
```

---

## Context Completeness (MANDATORY)

유저가 질문만 보고 스크롤업 없이 결정할 수 있어야 한다. 질문에 반드시 포함:

1. **`[tier ~N줄]` prefix** — 결정의 무게를 즉시 파악 (`decision-gate` Skill에서 산출)
2. **현재 상태** — 지금 코드/시스템이 어떻게 되어있는지 (코드 스니펫 포함)
3. **문제/이유** — 왜 결정이 필요한지 (실제 영향: 성능? 안정성? 데이터 유실?)
4. **각 선택지의 구체적 행동** — 선택하면 정확히 뭘 하는 건지 (어떤 파일, 어떤 변경, 작업량)
5. **트레이드오프** — 각 옵션의 장단점, 리스크
6. **리뷰 합의** — 3명 (너 + oracle-reviewer + oracle-gemini-reviewer) 투표 결과 + 추천

코드 리뷰 결정이면 문제 코드 스니펫 + 수정 코드 예시가 **반드시** 있어야 한다.
하나라도 빠지면 유저가 "이게 대체 뭔데?" 하면서 스크롤업해야 한다 → 이 UI의 존재 가치가 없다.

### Slack UI Constraints

- Slack UI renders up to 4 options as buttons (plus 1 "custom input" button). Keep options to **2-4**.

---

## When to Use / Not Use

### USE this skill when:
- `decision-gate`에서 switching cost >= medium으로 판정된 결정
- Architecture decision, data model, major dependency 등
- PR review에서 medium+ 이슈의 **구체적 구현 방식 선택** (어떤 접근법으로 고칠 것인가)

### DO NOT use when:
- Switching cost < small → `decision-gate` 자율 판단으로 해결
- Context is unclear → gather more context first or ask a structured clarifying question (PR review 컨텍스트에서는 plain text 절대 금지 — 컨텍스트가 부족하면 먼저 코드를 더 읽어서 구현 대안을 만들어라)
- Open-ended questions like "How can I help?"
- Guessing user intent with speculative options
- **"고칠까요? / 나중에? / 안 고침" 류의 Fix/Defer/Skip 3택** — 이건 의사결정이 아니라 확인 요청이다. P1 이상이면 당연히 고치는 것이고, 유저에게 물어야 하는 건 "어떤 방식으로 고칠 것인가"다.

---

## Bad Examples (NEVER do these)

### BAD: Fix/Defer/Skip 3택 (가장 흔한 퇴행 패턴 — 절대 금지)

```
→ 이 이슈를 이 PR에서 수정할까요? (fix_now / defer_to_followup / not_a_bug)
```

**Why this is UNACCEPTABLE:**

- **의사결정이 아니라 확인 요청** — P1이면 당연히 고쳐야 한다. "고칠까요?"는 무의미
- **구현 방식이 없다** — "고친다"와 "어떻게 고친다"는 완전히 다른 질문
- **유저 시간 낭비** — 유저가 yes/no 누르고 끝나는 건 UIAskUserQuestion을 쓸 이유가 없다
- **올바른 질문**: "어떤 방식으로 고칠 것인가" — Option A vs Option B (구현 대안 비교)

### BAD: Context-free code review question

```
:question: PR #944에서 P1 이슈 2건이 발견되었습니다. 어떻게 처리할까요?

P1-1: DbUpdateException을 when (IsDuplicateKeyException(ex)) 필터로 변경
P1-2: SoftDelete에서 entity.EffectiveTo = DateTime.UtcNow 추가

1️⃣ 이슈 수정 진행
2️⃣ PR 저자에게 위임
3️⃣ P2까지 같이 수정
```

**Why this is UNACCEPTABLE:**

- **ZERO context** — 현재 코드가 뭔지, 뭐가 문제인지, 어디를 고치는 건지 없음
- **tier 표기 없음** — 결정의 무게를 모름
- **리뷰 합의 없음** — 추천안의 근거가 없음
- **스크롤업 강요** — 유저가 리뷰 전문을 다시 읽어야 함

### BAD: No tier, no review consensus

```json
{
  "question": "캐시 전략을 결정해야 합니다",
  "options": [
    { "id": "1", "label": "Redis", "description": "빠름" },
    { "id": "2", "label": "In-memory", "description": "간단" }
  ]
}
```

### BAD: Should have been auto-decided

```json
// switching cost = tiny (~5줄) → 유저한테 묻지 마라. decision-gate 자율 판단 영역.
{
  "question": "에러 메시지를 한국어로 할까요 영어로 할까요?",
  "options": [
    { "id": "1", "label": "한국어" },
    { "id": "2", "label": "영어" }
  ]
}
```

---

## Good Example

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice_group",
      "question": "PR #944 코드 리뷰 — P1 이슈 2건 결정 필요",
      "context": "P0 3건 자율 수정 완료 (tiny~small, 3/3 합의), P2 5건은 별도 이슈로 분리됨.\n아래 P1 2건은 switching cost medium 이상 → 유저 결정 필요.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 P1-1: [medium ~50줄] DbUpdateException 예외 필터 누락\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n▸ 현재 코드 (`src/Repo/UserRepo.cs:45`):\n```csharp\ncatch (DbUpdateException ex) {\n    return Result.Conflict(); // 모든 DB 예외를 잡음\n}\n```\n\n▸ 문제: 네트워크 에러, 타임아웃 등이 조용히 Conflict로 처리됨 → 데이터 유실 위험\n\n▸ 수정안:\n```csharp\ncatch (DbUpdateException ex) when (IsDuplicateKeyException(ex)) {\n    return Result.Conflict();\n}\n```\n→ UserRepo.cs 외 3개 Repository 동일 패턴 적용 (총 4파일, ~50줄)\n\n▸ 🤖 리뷰 합의 (3/3 Option A 추천):\n  - Codex: Option A — when 필터가 가장 직관적, 변경 최소\n  - oracle-reviewer: Option A — catch-all 제거가 우선, Result<T> 전환은 과도\n  - oracle-gemini: Option A — 4파일 일괄 수정이 안전, Option B는 별도 리팩터링으로\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📌 P1-2: [medium ~40줄] SoftDelete에 EffectiveTo 누락\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n▸ 현재 코드 (`src/Services/EntityService.cs:112`):\n```csharp\npublic void SoftDelete(Entity entity) {\n    entity.IsDeleted = true; // EffectiveTo 안 찍힘\n    _db.SaveChanges();\n}\n```\n\n▸ 문제: 삭제 시점 추적 불가 → 감사 로그, 데이터 복구 시 언제 삭제됐는지 모름\n\n▸ 수정안:\n```csharp\npublic void SoftDelete(Entity entity) {\n    entity.IsDeleted = true;\n    entity.EffectiveTo = DateTime.UtcNow;\n    _db.SaveChanges();\n}\n```\n→ EntityService.cs + 파생 2개 서비스 (총 3파일, ~40줄)\n\n▸ 🤖 리뷰 합의 (2/3 Option A, 1/3 Option B):\n  - Codex: Option A — 1줄 추가로 감사 추적 확보, 빠르게 적용 가능\n  - oracle-reviewer: Option A — soft delete 기본 패턴으로 충분\n  - oracle-gemini: Option B — 인터셉터로 일관성 확보가 장기적으로 나음",
      "choices": [
        {
          "question": "[medium ~50줄] P1-1: DbUpdateException 예외 필터 — 구현 방식 선택",
          "options": [
            {
              "id": "p1_1_option_a",
              "label": "Option A: when 필터 추가 (추천 3/3)",
              "description": "catch (DbUpdateException ex) when (IsDuplicateKeyException(ex)) — 4파일 일괄 수정, 테스트 4개 추가. 간단하고 명확하나 IsDuplicateKeyException 헬퍼 필요"
            },
            {
              "id": "p1_1_option_b",
              "label": "Option B: Result<T> 패턴으로 전환",
              "description": "Repository에서 예외를 던지지 않고 Result<T>를 반환 — 6파일, ~80줄. 더 깔끔하지만 변경 범위 넓음"
            }
          ]
        },
        {
          "question": "[medium ~40줄] P1-2: SoftDelete EffectiveTo 누락 — 구현 방식 선택",
          "options": [
            {
              "id": "p1_2_option_a",
              "label": "Option A: SoftDelete에 직접 추가 (추천 2/3)",
              "description": "entity.EffectiveTo = DateTime.UtcNow 한 줄 추가 — 3파일, ~40줄. 빠르지만 기존 데이터 backfill 없음"
            },
            {
              "id": "p1_2_option_b",
              "label": "Option B: ISoftDeletable 인터페이스 + 인터셉터",
              "description": "SaveChanges 인터셉터에서 자동 EffectiveTo 설정 — 5파일, ~70줄. 향후 모든 엔티티에 자동 적용되나 EF 인터셉터 복잡도 증가"
            }
          ]
        }
      ]
    }
  }
}
```

---

## Key Principles

1. **`decision-gate` 먼저** — 질문을 만들기 전에 switching cost 판별. 자율 판단 영역이면 이 스킬을 쓰지 않는다.
2. **리뷰 선행** — oracle-reviewer + oracle-gemini-reviewer 리뷰 완료 후 질문을 구성한다.
3. **tier 표기** — 모든 질문에 `[tier ~N줄]` prefix. 유저가 결정의 무게를 즉시 안다.
4. **Actionable** — 선택하면 바로 진행 가능해야 한다. 추가 입력 요구 금지.
5. **Self-contained** — 스크롤업 없이 이 질문만 보고 결정할 수 있어야 한다.
