---
name: using-user-skills
description: 유저 개인 스킬을 만들고 사용하는 법. MANAGE_SKILL 모델 커맨드로 create/update/delete/list 하고 $user:name 으로 호출. 저장은 DATA_DIR/{userId}/skills/{name}/SKILL.md 로 멀티테넌트 격리.
---

# using-user-skills

## 만들기 (한 번)

`mcp__model-command__run` 을 `MANAGE_SKILL` 로 호출.

```json
{
  "commandId": "MANAGE_SKILL",
  "params": {
    "action": "create",
    "name": "<kebab-case>",
    "content": "<SKILL.md 전체 본문 — frontmatter 포함>"
  }
}
```

`content` 에 들어갈 SKILL.md 전체 형식:

```
---
name: <kebab-case>
description: 한 줄. 트리거 조건 + 행동을 한 문장으로.
---

<본문 — 모델이 따라야 할 지시>
```

## 호출

Slack 에서 `$user:<name>` 로 트리거. 호스트가 해당 스킬 본문을 다음 턴 프롬프트에 주입한다.

## 다른 액션

| action | params |
|---|---|
| `list`   | 없음 — 본인의 스킬 목록 반환 |
| `update` | `name`, `content` (전체 본문 교체) |
| `delete` | `name` |

## 함정

- **description 값에 작은따옴표 / 큰따옴표 / 줄바꿈 금지.** 호스트의 `extractDescription` 정규식이 첫 따옴표·줄바꿈에서 끊긴다. 끊기면 list 결과에 description 이 빈 문자열로 뜬다 — 발견 즉시 update 로 교체.
- **이름은 kebab-case.** `^[a-z0-9][a-z0-9-]*$` 만 통과. 대문자·언더스코어·점 불가.
- **유저 격리.** 다른 유저의 스킬은 보이지 않고, 그쪽에서도 내 스킬을 못 부른다.

## 예: "a 라고만 답하는 스킬"

```json
{
  "commandId": "MANAGE_SKILL",
  "params": {
    "action": "create",
    "name": "a",
    "content": "---\nname: a\ndescription: Triggered by $user:a. Reply must be exactly the lowercase letter a and nothing else.\n---\n\nOutput exactly one character: a\n\nNo formatting. No quoting. One letter. Then stop."
  }
}
```

호출: `$user:a` → 응답: `a`
