# Slack Block Kit + AI Bot Reference

Last verified: 2026-02-10  
Scope: Slack Block Kit UI + Messaging/Interactivity + AI app workflows + Agentforce path

이 문서는 기존 Slack 관련 문서를 하나로 통합한 레퍼런스다.  
필요한 섹션만 읽을 수 있도록 인덱스와 워크플로우 중심으로 구성했다.

## 0) Quick Index

| 내가 하려는 일 | 먼저 읽을 섹션 | 핵심 포인트 |
|---|---|---|
| `invalid_blocks` 에러 잡기 | 1.2, 1.3 | `button.disabled` 금지, 블록/길이 제한 |
| Block Kit 한도/스키마 점검 | 1.1 | 메시지 50 blocks, actions 25, context 10, context_actions 5 |
| Split view AI 앱 기본 구현 | 2.1~2.4 | `assistant:write`, `assistant_thread_started`, `message.im` |
| 스트리밍 답변 구현 | 2.5 | `chat.startStream -> chat.appendStream -> chat.stopStream` |
| 피드백 버튼 붙이기 | 2.6 | `context_actions` + `feedback_buttons` |
| Shortcut/Slash/Modal 트리거 추가 | 3.1~3.3 | 3초 ACK, `response_url`, `trigger_id` |
| Events API 기반 자동화 | 3.4 | 이벤트 수신 즉시 ACK 후 비동기 처리 |
| Agentforce 연동 | 3.5 | Auth Provider -> External Credential -> Named Credential -> Apex action |
| 운영 장애 대응 | 4 | `invalid_name`, `cant_update_message`, 429 대응 |

---

## 1) Chapter 1: Block UI 기준서

### 1.1 Block Kit 핵심 한도/필드

1. 전체 한도
- Message: 최대 50 blocks
- Modal/Home tab: 최대 100 blocks

2. 블록별 한도
- `actions` block: elements 최대 25
- `context` block: elements 최대 10
- `context_actions` block: elements 최대 5
- `section` block:
  - `text` 최대 3000
  - `fields` 최대 10, 각 최대 2000
  - `expand` 사용 가능
- `markdown` block:
  - payload 내 markdown text 총합 최대 12000
  - `block_id` 무시
  - 테이블, 구문 강조, 수평선, 태스크 리스트 미지원
- `rich_text` block:
  - 서브 엘리먼트: `rich_text_section`, `rich_text_preformatted`, `rich_text_quote`, `rich_text_list`
  - 인라인 엘리먼트: `text`, `link`, `emoji`, `user`, `channel`, `usergroup`, `broadcast`, `color`, `date`
  - 텍스트 스타일: `bold`, `italic`, `strike`, `code`, `underline`, `highlight`
  - `rich_text_list`: `style`(`bullet`|`ordered`), `indent`(0-8), `offset`, `border`
  - `rich_text_preformatted`: 코드 블록, `border` 옵션
  - `rich_text_quote`: 인용문, `border` 옵션
- `table` block:
  - `rows`: 최대 100행, 각 행 최대 20열
  - 셀 타입: `raw_text`(단순 텍스트) | `rich_text`(서식 포함)
  - `column_settings`: `align`(`left`|`center`|`right`), `is_wrapped`(boolean)
  - **메시지당 1개만 허용** (초과 시 `invalid_attachments` + `only_one_table_allowed`)
  - attachments로 메시지 하단에 렌더링
- `header` block:
  - `text`: `plain_text` 타입, 최대 150자
  - H1/H2 수준의 제목 표시

3. element/object 한도
- `text object`:
  - `plain_text` | `mrkdwn`
  - text 1~3000
  - `emoji`는 `plain_text`에서만
- `button`:
  - `text` 최대 75
  - `action_id` 최대 255
  - `value` 최대 2000
  - `url` 최대 3000
  - `disabled` 필드 없음
- `feedback_buttons`:
  - `positive_button`, `negative_button` 필수
  - 각 버튼 `text` 최대 75, `value` 최대 2000
- `icon_button`:
  - `icon: "trash"`만 지원
  - `visible_to_user_ids` 지원

### 1.2 메시징/인터랙션 필수 규칙

1. `chat.postMessage`에서 `blocks`를 쓸 때 top-level `text` fallback 포함
2. `chat.update`는 ephemeral 메시지 업데이트 불가
3. 인터랙션 payload는 3초 내 ACK
4. `response_url`은 30분 내 최대 5회
5. `trigger_id`는 3초 내 1회
6. 429 응답 시 `Retry-After` 준수
7. message update 시 `block_id` 재사용 금지

### 1.3 `invalid_blocks` 트러블슈팅 워크플로우

1. 첫 점검 순서
- undocumented 필드 포함 여부 (`button.disabled` 등)
- blocks/elements 개수 초과 여부
- 문자열 길이 제한 초과 여부
- block-element 조합 오류 여부

2. 수정 원칙
- "비활성"은 disable 필드 대신 숨김/상태문구/핸들러 거부로 처리
- 실패 payload는 민감정보 제거 후 로깅
- 블록 단위로 축소 재현해 원인 블록 확정

---

## 2) Chapter 2: AI 앱 표준 워크플로우 (Split View)

### 2.1 초기 셋업

1. Agents & AI Apps 기능 활성화
2. `assistant:write` scope 확인
3. 이벤트 구독 최소 구성
- `assistant_thread_started`
- `assistant_thread_context_changed`
- `message.im`
4. agent overview 설정

### 2.2 스레드 시작/컨텍스트 갱신

1. `assistant_thread_started` 수신 후 thread context 저장
2. context 기반 기능 전 `conversations.info` 접근 가능성 확인
3. 작업 시간이 길면 `assistant.threads.setStatus` 먼저 설정
4. `assistant.threads.setSuggestedPrompts`(최대 4개) 설정
5. 필요 시 `assistant.threads.setTitle` 설정
6. `assistant_thread_context_changed` 수신 시 context 갱신
7. 권한 부족으로 제한 context가 올 수 있으므로 fallback 분기 유지

### 2.3 사용자 메시지 처리 (`message.im`)

1. 직접 입력/추천 프롬프트 클릭 모두 `message.im`으로 처리
2. `thread_ts`를 conversation key로 사용
3. 필요 시 `conversations.replies`로 thread history 조회
4. 출력 포맷 정책(mrkdwn/길이/링크)을 고정
5. status on/off 경로를 실패 포함 전체 플로우에 강제

### 2.4 응답 전송 기본 정책

1. `chat.postMessage` + fallback `text` 포함
2. 긴 응답은 `section.expand = true` 검토
3. `chat.update` 연속 호출은 제한
4. ephemeral은 보조 알림 용도만 사용

### 2.5 스트리밍 워크플로우

1. 시작: `chat.startStream`
2. 중간: `chat.appendStream`
3. 종료: `chat.stopStream`

실무 체크:
1. stream timeout/abort 필수
2. 실패 시 일반 `chat.postMessage` fallback
3. 종료 시 status clear

### 2.6 피드백 UX 워크플로우

1. 응답 하단에 `context_actions` block 배치
2. `feedback_buttons`로 긍정/부정 피드백 노출
3. 필요 시 `icon_button`(trash) 사용
4. 액션 핸들러는 3초 ACK 우선, 후처리 비동기 분리
5. 피드백 저장은 최소 데이터 원칙 적용

### 2.7 보안/운영 규칙

1. Prompt injection 대응
- LLM 생성 시스템성 메시지를 재트리거 입력으로 사용 금지
- 도구 호출/데이터 접근 allowlist 유지
2. 비밀정보 보호
- token/client secret 로그/코드/UI 노출 금지
3. 데이터 보관
- 원문 장기 보관 대신 metadata 중심
4. 권한/플랜 제약
- AI 기능은 플랜/워크스페이스 정책의 영향 가능

---

## 3) Chapter 3: 확장 워크플로우 (모든 진입점)

### 3.1 Shortcut 기반

1. Message shortcut
- 메시지 컨텍스트와 함께 실행
- `response_url` 활용 가능
2. Global shortcut
- 컨텍스트 없이 시작
- 보통 modal로 입력 수집 후 실행
3. 공통
- 3초 ACK 필수

### 3.2 Slash command 기반

1. 빠른 트리거 용도로 적합
2. thread 내 slash command 동작은 제약 고려
3. 커맨드 시작 -> thread/DM 이어가기 패턴 권장
4. `response_url`, `trigger_id`를 모달/후속응답에 사용

### 3.3 Modal 기반 구조화 입력

1. `trigger_id` 획득 즉시 `views.open` (3초 제한)
2. 멀티스텝은 `views.push`
3. `view_submission`에서 입력 검증/에러 표시
4. 필요 시 `response_urls` 수집 구조로 설계

### 3.4 Events API 기반

1. 이벤트 수신 즉시 ACK(200), 처리는 비동기
2. 구독 이벤트는 필요한 범위로 최소화
3. 전형적 AI 패턴
- `app_mention`/`message.*`/`reaction_added` 트리거
- 컨텍스트 조회 -> LLM -> thread 게시
4. HTTP endpoint 또는 Socket Mode 중 운영 모델에 맞게 선택

### 3.5 Agentforce 연동 (Salesforce 경로)

1. Slack app 준비 (manifest/scope)
2. Salesforce Auth Provider 생성
3. External Credential 생성
4. Named Credential 생성
5. Apex invocable action 구현
6. Agent Builder에서 action/topic 연결
7. Slack 워크스페이스 배포

선택 기준:
1. Salesforce 데이터/워크플로우 중심이면 Agentforce 경로 유리
2. Slack 단독 제품/빠른 실험은 네이티브 Slack AI app 경로 유리

### 3.6 공통 운영 체크리스트

1. 인터랙션/커맨드/이벤트 3초 ACK 준수
2. 429 + `Retry-After` 재시도 정책 내장
3. Block payload 사전 검증(개수/길이/스키마)
4. 실패 시 사용자 안내 + status clear 보장
5. fallback 경로를 명시적으로 설계

---

## 4) 장애/오류 대응 맵

### 4.1 `invalid_blocks`

원인:
1. unsupported 필드 포함 (`button.disabled` 등)
2. 블록 개수/길이 제한 초과
3. block-element 조합 오류

대응:
1. unsupported 필드 제거
2. 제한 초과 분할 전송
3. payload 축소 재현으로 문제 블록 특정

### 4.2 `invalid_name` (reaction)

원인:
1. 유효하지 않은 emoji alias 사용

대응:
1. alias 검증 후 `reactions.add` 호출
2. 동적 emoji 소스는 사전 검증 캐시 사용

### 4.3 `cant_update_message`

원인:
1. 업데이트 불가능한 메시지(ephemeral 등) 대상
2. 현재 토큰 주체가 작성하지 않은 메시지 대상

대응:
1. update 가능 메시지만 갱신
2. ephemeral은 `response_url` 또는 재포스트 전략 사용

### 4.4 `user_not_in_channel` / `no_permission`

원인:
1. 대상 유저/봇의 채널 멤버십 문제

대응:
1. 멤버십 확인 후 전송
2. fallback 채널/현재 채널 유지 정책 적용

### 4.5 HTTP 429

원인:
1. method/workspace rate limit 초과

대응:
1. `Retry-After` 준수
2. per-method/per-channel throttling 적용

---

## 4.6) `/z` Block Kit 설정 카드 (#507, Phase 2)

`/z` 슬래시 커맨드는 모든 설정 토픽을 **Block Kit 카드**로 렌더링한다.
legacy 텍스트 출력은 fallback `text`로만 유지되고, 주 UX는 버튼 인터랙션이다.

### 5.1 구성 요소

| 모듈 | 역할 |
|------|------|
| `src/slack/z/ui-builder.ts` | `buildSettingCard`, `buildHelpCard`, `buildConfirmationCard`, `buildTombstoneCard` |
| `src/slack/z/topics/*-topic.ts` | 토픽별 `renderCard` / `apply` / `openModal` / `submitModal` (11개) |
| `src/slack/z/topics/index.ts` | `buildDefaultTopicRegistry()` — 11 토픽을 한 번에 등록 |
| `src/slack/actions/z-settings-actions.ts` | regex action/view 핸들러 (`ZSettingsActionHandler`) |
| `src/slack/actions/index.ts` | `ActionHandlers.registerHandlers(app)` 안에서 z-settings 핸들러 자동 wiring |

### 5.2 Action ID 규약

모든 `/z` Block Kit 버튼의 `action_id`는 다음 규칙을 따른다:

| 패턴 | 용도 |
|------|------|
| `z_setting_<topic>_set_<value>` | 설정값 적용 (예: `z_setting_model_set_opus`) |
| `z_setting_<topic>_cancel` | 카드 닫기 (dismiss) |
| `z_setting_<topic>_open_modal` | 입력 모달 열기 |
| `z_setting_<topic>_modal_submit` | `view.callback_id` — 모달 submit |
| `z_help_nav_<topic>` | help 카드 → 토픽 카드 네비게이션 |

`block_id`는 `zBlockId(topic, issuedAt, index)`로 deterministic하게 생성한다:
`z_<topic>_<issuedAt>_<index>`.

### 5.3 Source-aware ZRespond 재구성 (중요)

action handler가 카드를 교체(`replace`)할 때, **원래 전송한 surface와 동일한
경로**로 응답해야 한다. 잘못 선택하면 "UI 만료" 또는 이중 렌더 발생.

| Source | 감지 방법 | 응답 방식 |
|--------|-----------|-----------|
| DM | `body.container.channel_id.startsWith('D')` | `chat.update({ channel, ts: botMessageTs })` — branded `BotMessageTs`는 `body.message.ts`로부터 `DmZRespond.fromAction(body, client)`가 검증 |
| Channel (ephemeral) / Slash | `body.response_url` 존재 | `response_url` POST + `replace_original: true` — `chat.update` 절대 금지 (ephemeral은 편집 불가) |
| Slash (fallback) | response_url 없음 | `SlashZRespond(respondFn)` — Bolt의 `respond()` 사용 |

재구성 진입점: `respondFromActionBody({ body, client, respond })` in `z-settings-actions.ts`.

### 5.4 Flow (help → nav → set)

```
/z  (empty remainder)
  └─> ZRouter → buildHelpCard({issuedAt})
       └─> 카테고리별 z_help_nav_<topic> 버튼 (5개/row)

[user clicks z_help_nav_<topic>]
  └─> ZSettingsActionHandler.handleHelpNav
       └─> registry.get(topic).renderCard({userId, issuedAt})
            └─> zRespond.replace({text, blocks})  // 원 카드와 같은 surface

[user clicks z_setting_<topic>_set_<value>]
  └─> ZSettingsActionHandler.handleSet
       └─> binding.apply({userId, value, actionId, body})
            ├─ ok:true,  dismiss:false → buildConfirmationCard + replace
            ├─ ok:true,  dismiss:true  → zRespond.dismiss()
            └─ ok:false              → error confirmation
```

### 5.5 모달 (open_modal / modal_submit)

텍스트 입력이 필요한 토픽(`email`, `notify` telegram id, `memory` 추가)은
`openModal` 훅에서 `views.open({ trigger_id, view })`를 호출한다. View의
`callback_id`는 반드시 `z_setting_<topic>_modal_submit` 패턴을 따른다.

`handleModalSubmit`은 `body.view.state.values` 전체를 해당 토픽 binding의
`submitModal`에 전달한다. **모달은 `replace()` 불가** — 사용자 피드백은
`client.chat.postMessage` (DM ack) 또는 postEphemeral로 별도 전송한다.

### 5.6 테스트 커버리지

| 파일 | 내용 |
|------|------|
| `src/slack/z/ui-builder.test.ts` | 각 builder의 block 구조, 한도 (actions 25, context 10) |
| `src/slack/actions/z-settings-actions.test.ts` | source 선택, set/cancel/nav/open_modal/submit 라우팅 |
| `src/slack/z/topics/<topic>-topic.test.ts` | 토픽별 apply/render 로직 |
| `src/slack/z/topics/index.test.ts` | 11 토픽 registry 등록 |
| `src/slack/z/topics/flow-e2e.test.ts` | help → nav → set e2e, 모든 토픽 렌더 smoke |

### 5.7 새 토픽 추가 체크리스트

1. `src/slack/z/topics/<topic>-topic.ts`에 `render*Card`, `apply*`, `create*TopicBinding` 작성
2. (선택) `openModal` / `submitModal` 훅 구현 — `buildXxxModal()` View 페이로드 포함
3. `src/slack/z/topics/index.ts`의 `registerAllTopics`에 binding 추가
4. `ui-builder.ts`의 `DEFAULT_HELP_CATEGORIES`에 nav 버튼 등록
5. `<topic>-topic.test.ts`에 `renderCard` + `apply` + (modal) 테스트 추가
6. `flow-e2e.test.ts`는 자동으로 새 토픽을 smoke test에 포함함 (registry 순회)

---

## 5) 이 리포 문서 연결

- Slack UI 액션 패널 스펙: `docs/spec/13-slack-ui-action-panel.md`
- `/z` 슬래시 커맨드 마스터 스펙: `plan/MASTER-SPEC.md` (§8 Block Kit, §15 actions/view id)

---

## 6) Official Reference Map

### Core
- https://docs.slack.dev/block-kit/
- https://docs.slack.dev/ai/developing-ai-apps

### Block Kit / Messaging / Interactivity
- https://docs.slack.dev/reference/block-kit/blocks/
- https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/
- https://docs.slack.dev/reference/block-kit/blocks/table-block/
- https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
- https://docs.slack.dev/block-kit/formatting-with-rich-text/
- https://docs.slack.dev/reference/block-kit/blocks/actions-block/
- https://docs.slack.dev/reference/block-kit/blocks/context-actions-block/
- https://docs.slack.dev/reference/block-kit/blocks/context-block/
- https://docs.slack.dev/reference/block-kit/blocks/section-block/
- https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
- https://docs.slack.dev/reference/block-kit/composition-objects/text-object/
- https://docs.slack.dev/reference/block-kit/block-elements/button-element/
- https://docs.slack.dev/reference/block-kit/block-elements/feedback-buttons-element/
- https://docs.slack.dev/reference/block-kit/block-elements/icon-button-element/
- https://docs.slack.dev/reference/methods/chat.postMessage/
- https://docs.slack.dev/reference/methods/chat.update/
- https://docs.slack.dev/reference/methods/chat.postEphemeral/
- https://docs.slack.dev/interactivity/handling-user-interaction/
- https://docs.slack.dev/apis/web-api/rate-limits/
- https://docs.slack.dev/reference/methods/reactions.add/

### AI Apps
- https://docs.slack.dev/ai/ai-apps-best-practices/
- https://docs.slack.dev/reference/methods/assistant.threads.setStatus/
- https://docs.slack.dev/reference/methods/assistant.threads.setSuggestedPrompts/
- https://docs.slack.dev/reference/methods/assistant.threads.setTitle/
- https://docs.slack.dev/reference/methods/chat.startStream/
- https://docs.slack.dev/reference/methods/chat.appendStream/
- https://docs.slack.dev/reference/methods/chat.stopStream/

### Entry Points / Security
- https://docs.slack.dev/apis/events-api
- https://docs.slack.dev/interactivity/implementing-shortcuts/
- https://docs.slack.dev/interactivity/implementing-slash-commands/
- https://docs.slack.dev/surfaces/modals/
- https://docs.slack.dev/security/

### Agentforce
- https://docs.slack.dev/ai/getting-started-with-agentforce/
- https://docs.slack.dev/ai/customizing-agentforce-agents-with-custom-slack-actions/
