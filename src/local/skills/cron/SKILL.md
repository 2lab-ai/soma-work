---
name: cron
description: "Cron/schedule manager UI. Trigger when the user types cron, schedule, scheduler, 크론, 스케줄, 스케쥴, 스케줄러, 스케쥴러 — or asks to see/change their cron jobs' model or output target. Lists all visible cron jobs (admins see every user's jobs with owner; non-admins see their own), then offers one-tap changes for the per-job model (default = creator's current model / fast / a specific model) and the output target (channel/thread/dm) via structured choice buttons."
---

# cron — 크론잡 관리 UI

유저가 `cron` / `schedule` / `크론` / `스케줄` / `스케쥴` 등을 입력하면 이 스킬로 진입한다.
목적: 현재 크론잡을 리스트업하고, 각 잡의 **모델**과 **출력 대상**을 버튼 몇 번으로 확인·변경하게 한다.

## 권한 모델 (admin scoping)

- 스코핑은 서버 측(`SOMA_CRON_CONTEXT.isAdmin`, 부모 프로세스가 ADMIN_USERS로 계산)에서 강제된다. 스킬은 이를 신뢰하고 그대로 렌더한다.
- **non-admin**: `cron_list`가 자기 잡만 반환한다. owner 파라미터는 서버가 거부한다.
- **admin**: `cron_list`가 모든 유저의 잡을 `owner:<@U...>`와 함께 반환한다. 다른 유저의 잡을 수정/삭제할 때는 `cron_update`/`cron_delete`에 **owner 파라미터를 반드시 명시**한다 (암묵적 cross-user 수정은 서버가 거부).

## Flow

### 1. 리스트업

`mcp__cron__cron_list`를 호출하고 결과를 그대로 가공해 보여준다. 잡마다 반드시 표기:

- 이름, 스케줄(`0 9 * * 1-5` + 사람이 읽는 설명, KST 변환 포함 — cron은 UTC 평가)
- **모델**: `model:default(creator current model)` → "만든 사람(오너)의 현재 기본 모델을 실행 시점에 사용" / `fast` → sonnet / `custom(<id>)` → 고정 모델
- **출력 대상**: `target:channel`(채널에 새 메시지) / `thread(ts:...)`(스레드 답글) / `dm`(오너에게 DM) — 기본값도 생략하지 말고 명시
- admin 뷰면 owner(`<@U...>`)도 표기

잡이 없으면 "등록된 크론잡 없음" + `cron_create` 사용법 한 줄로 끝낸다.

### 2. 변경 대상 선택 — UIAskUserQuestion

`local:UIAskUserQuestion` 스킬(= `mcp__model-command__run` ASK_USER_QUESTION)로 **user_choice_group** 하나에 묶어 질문한다:

- Q1 "어떤 잡을 변경할까요?" — 잡당 옵션 1개 (label: 잡 이름, description: 현재 모델·출력 대상 요약) + "변경 안 함"
- Q2 "무엇을 변경할까요?" — `모델 변경` / `출력 대상 변경` / `스케줄·프롬프트 변경` / `삭제`

질문 prefix는 `[small]` 정도면 충분하다. 잡이 1개뿐이면 Q1을 생략하고 그 잡을 대상으로 Q2만 묻는다.

### 3. 값 선택 — 두 번째 질문

**모델 변경** 선택 시 (recommended = default):

- `default` — 만든 사람의 **현재** 기본 모델을 실행 시점에 사용 (override 해제, 추천)
- `fast` — sonnet 고정 (가벼운 정기 작업용)
- 특정 모델 — `claude-fable-5`, `claude-opus-4-8[1m]`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `gpt-5.5` 중 택 (canonical id는 `src/user-settings-store.ts` AVAILABLE_MODELS 기준 — 유저가 다른 모델을 원하면 `✏️ Other`로 직접 입력받아 `model_type=custom, model_name=<입력>`으로 전달)

**출력 대상 변경** 선택 시:

- `channel` — 채널에 새 메시지 (thread anchor 자동 해제)
- `thread` — 지정 스레드에 답글 (threadTs 필요 — 현재 스레드를 쓰려면 컨텍스트의 threadTs 전달)
- `dm` — 잡 오너에게 DM

### 4. 적용 + 확인

`mcp__cron__cron_update`로 적용한다 (부분 업데이트 — 바꿀 필드만 전달):

- 모델: `{name, model_type: 'default'}` (해제) / `{name, model_type: 'custom', model_name: 'gpt-5.5'}`
- 출력: `{name, target: 'dm'}` / `{name, target: 'thread', threadTs: '...'}` / `{name, target: 'channel'}`
- admin이 타인 잡 수정: `{name, owner: 'U...', ...}`
- 삭제 선택 시엔 `mcp__cron__cron_delete` (`admin`은 owner 명시)

적용 후 `cron_list`를 다시 호출해 변경된 상태를 보여주고 종료한다. 스케줄러는 매 tick마다 디스크에서 다시 읽으므로 재시작 없이 다음 분부터 반영된다.

## Anti-patterns

- 리스트만 보여주고 변경 버튼 없이 끝내기 — 이 스킬의 존재 이유가 "쉽게 선택하고 변경"이다.
- 모델/출력 대상을 생략하고 이름·스케줄만 보여주기.
- non-admin에게 다른 유저 잡을 보여주려고 시도하기 (서버가 어차피 안 준다).
- 변경을 위해 delete + create 재조합 — `cron_update`가 있다. lastRun 이력이 날아간다.
