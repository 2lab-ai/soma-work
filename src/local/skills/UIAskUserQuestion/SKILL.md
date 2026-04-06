---
name: UIAskUserQuestion
description: Send structured user-choice questions via model-command tool (Slack UI renders as buttons)
---

# UIAskUserQuestion — Structured User Choice

When your turn ends and you need the user to make a real decision, call the `ASK_USER_QUESTION` model-command with a `user_choice` or `user_choice_group` payload. Slack renders it as buttons + a `✏️ 직접 입력` (Other) button that is **added automatically by the renderer** — never put an "Other/기타" option in your `choices`.

## Pre-requisite: decision-gate

먼저 `decision-gate` Skill 로 switching cost tier 를 판정한다.

- **tier < small** → 자율 판단 (3인 리뷰 다수결). 이 스킬을 쓰지 마라.
- **tier ≥ medium** → 이 스킬로 구현 방식을 물어라.

자율 판단 가능한 것을 유저에게 묻는 건 시간 낭비다.

## Primary action

`mcp__model-command__run` 을 호출:

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice",
      "question": "[medium ~50줄] <질문>",
      "context": "<현재 상태 · 문제 · 영향 · 수정안 코드 · 리뷰 합의>",
      "choices": [
        { "id": "1", "label": "Option A: <행동> (Recommended · 추천 3/3)", "description": "<트레이드오프>" },
        { "id": "2", "label": "Option B: <행동>",                        "description": "<트레이드오프>" }
      ]
    }
  }
}
```

여러 결정이 묶여 있으면 `type: "user_choice_group"` + `choices: [{question, options:[...]}]` 배열.

> Fallback (tool unavailable): 동일 구조 JSON 을 메시지에 그대로 출력한다. **PR review 컨텍스트에서는 plain text 절대 금지** — 반드시 구조화된 JSON 또는 tool call.

## Question writing rules

1. **`[tier ~N줄]` prefix** — 모든 질문에 결정 무게 표기. tier 는 `decision-gate` 에서 산출 (tiny ~5 / small ~20 / medium ~50 / large ~100 / xlarge ~500).
2. **한 질문 = 한 결정** — tightly scoped. 여러 결정은 `user_choice_group` 으로 분리.
3. **Self-contained `context`** — 유저가 스크롤업 없이 결정 가능해야 함. 반드시 포함:
   - 현재 상태 (코드 스니펫)
   - 문제/영향 (성능? 안정성? 데이터 유실?)
   - 각 옵션의 구체 행동 (파일·변경·작업량)
   - 각 옵션의 트레이드오프
   - 3인 리뷰 합의 (Codex + oracle-reviewer + oracle-gemini-reviewer)
4. **2–4 옵션** — Slack UI 가 `1️⃣–4️⃣` 버튼 4개까지 렌더. 5번째부터는 잘린다. `multiSelect` 미지원 (single-select only).
5. **추천안은 첫 번째** — label 에 `(Recommended · 추천 N/M)` 표기. N/M 은 리뷰 투표수.
6. **Actionable label** — 선택 즉시 실행 가능한 구체적 행동. "생각해볼게요" 같은 메타 옵션 금지.
7. **Plan mode 에서 `plan` 언급 금지** — 유저는 plan 을 UI 에서 보지 못한다. plan 승인은 `ExitPlanMode` 의 몫이며 이 tool 은 요구사항 확정용이다.
8. **Fallback default 명시** — `context` 끝에 "무응답 시 Option A 로 진행" 같은 기본 동작을 적으면 진행을 막지 않는다 (선택).

## When to use / not use

### USE this skill when:
- `decision-gate` 에서 switching cost **≥ medium** 인 결정
- Architecture, data model, major dependency 교체
- PR review 에서 medium+ 이슈의 **구체적 구현 방식 선택** ("어떤 방식으로 고칠 것인가")

### DO NOT use when:
- Switching cost < small → `decision-gate` 자율 판단으로 해결
- 컨텍스트 불충분 → 먼저 코드를 더 읽어 구현 대안을 만들어라 (PR review 컨텍스트에서는 **plain text 절대 금지**)
- Open-ended 질문 ("어떻게 도와드릴까요?")
- 추측성 옵션으로 유저 의도 떠보기
- 비밀/크레덴셜 공개를 챗에서 요구
- **"고칠까요 / 나중에 / 안 고침" 류 Fix/Defer/Skip 3택** — 확인 요청일 뿐 의사결정이 아니다. P1+ 는 고치는 게 자명. 물어야 할 건 "**어떻게** 고칠까".

---

## Bad Examples

### BAD: Fix/Defer/Skip 3택 (절대 금지)

```
→ 이 이슈를 이 PR 에서 수정할까요? (fix_now / defer_to_followup / not_a_bug)
```

의사결정이 아니라 단순 확인. 구현 방식이 없다. 올바른 질문은 Option A vs Option B.

### BAD: Context-free 질문

```
question: "PR #944 에서 P1 이슈 2건 발견. 어떻게 처리할까요?"
choices:  [수정 진행, PR 저자에게 위임, P2 까지 같이]
```

tier 없음, 코드 스니펫 없음, 문제 설명 없음, 리뷰 합의 없음 → 유저가 스크롤업 강요당함 → 이 UI 존재 이유 상실.

---

## Good Example

```json
{
  "commandId": "ASK_USER_QUESTION",
  "params": {
    "payload": {
      "type": "user_choice",
      "question": "[medium ~50줄] P1-1: DbUpdateException 예외 필터 누락 — 구현 방식 선택",
      "context": "▸ 현재 (`src/Repo/UserRepo.cs:45`):\n```csharp\ncatch (DbUpdateException ex) { return Result.Conflict(); }\n```\n▸ 문제: 네트워크/타임아웃 등 모든 DB 예외를 Conflict 로 처리 → 데이터 유실 위험.\n▸ 리뷰 합의 (3/3 Option A): Codex · oracle-reviewer · oracle-gemini 전원.\n▸ 무응답 시 기본 행동: Option A 로 진행.",
      "choices": [
        {
          "id": "option_a",
          "label": "Option A: when 필터 추가 (Recommended · 추천 3/3)",
          "description": "`catch (DbUpdateException ex) when (IsDuplicateKeyException(ex))` — 4 파일 일괄 수정, 테스트 4 추가. 변경 최소·직관적."
        },
        {
          "id": "option_b",
          "label": "Option B: Result<T> 패턴 전환",
          "description": "Repository 에서 예외 던지지 않고 Result<T> 반환 — 6 파일, ~80 줄. 깔끔하지만 범위 넓음."
        }
      ]
    }
  }
}
```

## Key Principles

1. **`decision-gate` 먼저** — 자율 판단 영역이면 이 스킬을 쓰지 않는다.
2. **Self-contained** — tier · 코드 · 문제 · 옵션 · 리뷰 합의가 `context` 에 다 들어있어야 한다.
3. **Actionable Option A/B** — 고르면 바로 실행. 추가 입력 요구 금지. "Other" 버튼은 Slack 이 자동으로 붙인다.
