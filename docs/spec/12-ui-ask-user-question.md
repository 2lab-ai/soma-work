# UIAskUserQuestion (User Choice UI) Specification

## Version
- Document Version: 1.0
- Source Files:
  - Skill spec: `src/local/skills/UIAskUserQuestion/SKILL.md`
  - Prompt injection: `src/prompt/common.prompt`
  - Extraction/normalization: `src/slack/user-choice-extractor.ts`, `src/slack/user-choice-handler.ts`
  - Slack UI: `src/slack/choice-message-builder.ts`
  - Stream integration: `src/slack/stream-processor.ts`, `src/slack/pipeline/stream-executor.ts`
  - Action handling/state: `src/slack/actions/index.ts`, `src/slack/actions/choice-action-handler.ts`, `src/slack/actions/form-action-handler.ts`, `src/slack/actions/pending-form-store.ts`
  - Types: `src/types.ts`
- Last Updated: 2026-02-03

## 1. Overview

UIAskUserQuestion은 **모델이 유저에게 “결정이 필요한 질문”을 던져야 할 때** 텍스트로 질문을 길게 늘어놓지 않고, **구조화된 JSON(선택지)** 으로 질문을 출력하도록 강제하는 규약/스킬입니다.

`soma-work`는 모델 응답에서 해당 JSON을 감지해:
1) JSON을 유저에게 그대로 노출하지 않고(모델 응답에서 제외),
2) Slack Block Kit UI(버튼/폼/모달)로 렌더링해 유저에게 보여주며,
3) 유저의 클릭/입력 결과를 서버가 관리한 뒤,
4) **최종 선택 결과만** 다시 모델에게 “유저 메시지”로 전달합니다.

즉, “모델 → JSON(질문/선택지) → Slack UI → 유저 선택 → 모델”의 인터랙티브 루프를 제공하는 기능입니다.

## 2. End-to-End Flow

```
┌────────┐         ┌────────────────────┐          ┌─────────────┐
│ User   │         │ soma-work (Slack)  │          │ Model       │
└───┬────┘         └─────────┬──────────┘          └────┬────────┘
    │ 1) 질문/작업 요청         │                             │
    │────────────────────────>│ 2) streamQuery(prompt)       │
    │                         │────────────────────────────>│
    │                         │ 3) assistant text + JSON     │
    │                         │<────────────────────────────│
    │                         │ 4) JSON 추출/제거            │
    │                         │ 5) Slack UI 렌더링           │
    │<────────────────────────│    (버튼/폼/모달)             │
    │ 6) 버튼 클릭/직접 입력     │                             │
    │────────────────────────>│ 7) 선택 상태 저장/업데이트    │
    │                         │ 8) 최종 결과만 모델로 전달     │
    │                         │────────────────────────────>│
    │                         │ 9) 모델이 선택을 반영해 계속   │
    │<────────────────────────│    응답(또는 다음 질문)        │
```

## 3. Model Output Contract (JSON)

### 3.1 기본 원칙
- **유저가 스크롤로 맥락을 찾지 않아도** 선택할 수 있도록 `question`/`context`에 필요한 배경을 포함합니다.
- 선택지는 **즉시 실행 가능한 액션**이어야 합니다(선택 후 추가 질문 없이 다음 단계 진행 가능).
- Slack UI 제약상 **옵션은 최대 4개**를 권장합니다(5개 이상은 UI에서 잘립니다).
- 모델 응답에 **한 번에 하나의 choice JSON**만 출력하는 것을 권장합니다(추출기는 “첫 매치”만 처리).
- JSON은 가능하면 응답 맨 아래에 ` ```json ... ``` ` 코드블록으로 출력합니다.

### 3.2 권장 포맷: `user_choice_group` (복수 질문 지원)
모델이 여러 질문을 한 번에 묶어서 받을 때 사용하는 “권장 포맷”입니다.

```json
{
  "type": "user_choice_group",
  "question": "상위 컨텍스트 질문 (폼 제목)",
  "context": "왜 이 결정을 해야 하는지 / 무엇이 달라지는지",
  "choices": [
    {
      "type": "user_choice",
      "question": "개별 질문",
      "context": "이 질문의 배경/의사결정 포인트",
      "options": [
        { "id": "1", "label": "옵션 A", "description": "A의 트레이드오프" },
        { "id": "2", "label": "옵션 B", "description": "B의 트레이드오프" }
      ]
    }
  ]
}
```

`soma-work`는 이를 내부적으로 다음 중 하나로 정규화합니다:
- 질문이 1개면 → `user_choice` (단일 질문 UI)
- 질문이 2개 이상이면 → `user_choices` (멀티 질문 폼 UI)

### 3.3 단일 포맷: `user_choice`
단일 질문만 필요할 때의 축약 포맷입니다.

```json
{
  "type": "user_choice",
  "question": "질문",
  "context": "결정이 필요한 이유",
  "options": [
    { "id": "1", "label": "A", "description": "..." },
    { "id": "2", "label": "B", "description": "..." }
  ]
}
```

### 3.4 내부 포맷(호환/테스트용): `user_choices`
멀티 질문 “폼”을 직접 표현하는 내부 포맷입니다.

```json
{
  "type": "user_choices",
  "title": "폼 제목",
  "description": "폼 설명",
  "questions": [
    {
      "id": "q1",
      "question": "질문 1",
      "context": "선택 배경",
      "choices": [
        { "id": "1", "label": "A", "description": "..." }
      ]
    }
  ]
}
```

⚠️ `user_choices`를 모델이 직접 출력하는 것은 권장하지 않습니다.
- `questions[].choices`만 인식합니다. `questions[].options`는 자동 변환되지 않습니다.
- 권장 포맷(`user_choice_group`)을 쓰면 `options/choices` 양쪽을 안전하게 수용합니다.

### 3.5 호환성 규칙(파서가 수용하는 변형)
`src/slack/user-choice-extractor.ts` 기준:
- `user_choice.options` 또는 `user_choice.choices` 둘 다 허용(내부로는 `choices`로 정규화)
- `user_choice_group`의 각 choice도 `options` 또는 `choices` 허용
- `user_choice_group.type`은 `user_choice_group` 또는 생략(권장은 명시)

## 4. Model Prompting (스킬/프롬프트)

### 4.1 시스템 프롬프트(모델에게 주입)
기본 시스템 프롬프트는 `src/prompt/default.prompt` → `{{include:./common.prompt}}` 를 통해 `src/prompt/common.prompt` 내용을 포함합니다.

`src/prompt/common.prompt`에는 UIAskUserQuestion 관련 핵심 지시가 포함됩니다:
- **"ALWAYS use 'local:UIAskUserQuestion', NEVER use 'AskUserQuestion' tool."**
- 불명확/결정이 필요하면 UIAskUserQuestion 스킬을 통해 유저에게 질문(선택지)로 확인

### 4.2 스킬 정의(출력 계약)
UIAskUserQuestion 스킬은 로컬 플러그인으로 로드됩니다:
- 로드 코드: `src/claude-handler.ts` (`plugins: [{ type: 'local', path: .../local }]`)
- 스킬 문서: `src/local/skills/UIAskUserQuestion/SKILL.md`

이 스킬 문서는 “결정이 필요한 경우 JSON으로 출력하라”는 포맷/룰을 제공합니다.

## 5. Detection & Filtering (모델 응답에서 JSON 제외)

### 5.1 어디서 처리되는가
Slack 스트림 처리 파이프라인에서 모델 응답 텍스트를 처리할 때 choice JSON을 감지합니다:
- `src/slack/stream-processor.ts`
  - `handleTextMessage()`
  - `handleFinalResult()`

### 5.2 추출기(Extractor) 동작
`src/slack/user-choice-extractor.ts`의 `extractUserChoice(text)`가 수행합니다:
1. 우선 ` ```json ... ``` ` 코드블록을 탐색하며 JSON 파싱 시도
2. 실패 시 raw JSON(`{ "type": ... }` 또는 `{ "question": ... }`)을 탐색
   - 문자열/escape를 고려해 **brace balance**로 JSON object 범위를 추출
3. 파싱된 JSON이 `user_choice` / `user_choices` / `user_choice_group`이면 “choice”로 인정하고 반환

### 5.3 JSON 제거 방식
- 코드블록(` ```json ... ``` `)으로 발견된 경우: 해당 블록만 제거하고 나머지 텍스트는 유지합니다.
- raw JSON으로 발견된 경우: JSON 시작점 이전 텍스트만 `textWithoutChoice`로 남기며, JSON 이후 텍스트는 버립니다(권장 사용 패턴은 “JSON을 응답 하단에 둔다”).

## 6. Slack UI Rendering

### 6.1 단일 질문 UI
`src/slack/choice-message-builder.ts`의 `buildUserChoiceBlocks()`가 Slack attachments/blocks를 생성합니다.

특징:
- 질문/컨텍스트 표시
- 최대 4개 옵션을 1~4 버튼으로 표시(각 버튼은 action_id: `user_choice_<id>`)
- “✏️ 직접 입력” 버튼 제공(action_id: `custom_input_single`)

UI 제약:
- Slack actions 블록은 요소 5개 제한 → (옵션 4개 + 직접입력 1개) 고정
- 따라서 모델은 옵션을 2~4개로 설계하는 것을 권장

### 6.2 멀티 질문(폼) UI
`buildMultiChoiceFormBlocks()`가 “진행률/질문별 선택/변경/제출” UI를 생성합니다.

특징:
- 진행률 표시(●○) + 완료 카운트
- 질문별 선택: action_id `multi_choice_<formId>_<questionId>_<optId>`
- 선택 완료 후 “🔄 변경” 버튼으로 재선택 가능(action_id `edit_choice_...`)
- 모든 질문 완료 시 “🚀 제출하기 / 🗑️ 모두 초기화” 표시
- 질문마다 “✏️ 직접 입력” 모달 제공(action_id `custom_input_multi_<formId>_<questionId>`)

### 6.3 Slack 블록 제한 대응(폼 분할)
Slack은 메시지당 blocks 50개 제한이 있어, `src/slack/stream-processor.ts`는 멀티 질문을 분할합니다:
- `MAX_QUESTIONS_PER_FORM = 6`
- 7개 이상 질문이면 6개씩 쪼개 여러 폼 메시지로 전송

### 6.4 UI 전송 실패 시 fallback
Slack API 에러(블록 제한 등) 발생 시:
- 버튼 UI 대신 텍스트로 옵션 목록을 보여주고 “번호로 응답”하도록 안내합니다.
- 구현: `src/slack/stream-processor.ts` → `sendChoiceFallback()`

## 7. User Interaction Handling (Slack → soma-work)

### 7.1 액션 라우팅
Slack action은 `src/slack/actions/index.ts`에서 등록됩니다:
- 단일 선택: `/^user_choice_/` → `ChoiceActionHandler.handleUserChoice`
- 멀티 선택: `/^multi_choice_/` → `ChoiceActionHandler.handleMultiChoice`
- 변경/제출/초기화: `edit_choice_`, `submit_form_`, `reset_form_`
- 직접입력: `custom_input_single`, `/^custom_input_multi_/` + modal view `custom_input_submit`

### 7.2 단일 선택 처리
`src/slack/actions/choice-action-handler.ts`:
- 버튼 value(JSON)에서 `{ sessionKey, choiceId, label, question }` 파싱
- 선택 완료 상태로 메시지 업데이트
- 세션이 있으면 모델에게 유저 응답 전달:
  - 전달 text: `choiceId` (예: `"1"`)
  - activityState를 `working`으로 전환

### 7.3 멀티 선택 처리(상태 저장 + 제출)
멀티 폼은 유저가 질문별로 하나씩 선택하며 서버가 상태를 관리합니다:
- 상태 저장소: `src/slack/actions/pending-form-store.ts`
  - 파일 영속화: `data/pending-forms.json`
  - TTL: 24h (`FORM_TIMEOUT`)
- `handleMultiChoice()`:
  - `pendingForm.selections[questionId] = { choiceId, label }`
  - Slack 메시지 UI를 현재 선택 상태로 갱신
- `handleFormSubmit()`:
  - 모든 질문에 답변했는지 검증 후 제출
  - 제출 시 모델로 전달되는 text는 질문/답을 합친 문자열:
    - 예: `"DB 선택?: 1. Postgres\nAuth 방식?: 2. OAuth"`

### 7.4 직접 입력(모달)
`src/slack/actions/form-action-handler.ts`:
- “직접 입력” 클릭 시 Slack modal(`views.open`)로 입력 UI 제공
- Submit 시:
  - 단일 질문: 입력 텍스트 그대로 모델에 전달
  - 멀티 질문: 해당 질문의 선택으로 저장(`choiceId: '직접입력'`)
    - 현재 구현은 **마지막 미응답 질문이 직접입력으로 채워져 전체가 완료되면 자동 제출**합니다.

## 8. Session/Status Integration

### 8.1 모델 응답이 “선택 대기”로 끝난 경우
`src/slack/pipeline/stream-executor.ts`:
- 스트림 결과에 `hasUserChoice=true`면:
  - Slack 상태를 `waiting`으로 표시
  - 세션 `activityState`를 `waiting`으로 전환

### 8.2 유저가 선택/제출한 경우
Choice/Form 액션 핸들러는:
- 세션 `activityState`를 `working`으로 전환하고
- `messageHandler`로 유저 메시지를 “일반 메시지처럼” Claude로 전달하여 다음 턴을 진행합니다.

## 9. Tests
- JSON 추출/정규화/Slack 블록 생성 테스트: `src/slack/user-choice-handler.test.ts`
- 스트림에서 choice 감지/폼 생성 테스트: `src/slack/stream-processor.test.ts`

실행:
```bash
npm test
```

