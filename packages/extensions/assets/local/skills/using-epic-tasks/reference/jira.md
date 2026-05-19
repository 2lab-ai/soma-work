# Jira issue reference — using-epic-tasks 부속

Atlassian Jira Cloud로 Case B의 에픽+서브이슈를 구현할 때의 문법/API. Cloud 기준 (REST v3). Case A 단일 이슈도 이 참조를 사용.

## 1. Issue type 계층 — 본 스킬은 Epic → Story

- Jira 기본 계층: `Epic (L1) > Story/Task/Bug (L0) > Sub-task (L-1)`.
- **본 스킬에서 "서브이슈" = Story/Task (L0).** Sub-task(L-1)는 쓰지 않음 — 독립 PR·독립 워크트리·독립 에이전트 세션이 안 됨 (Invariant 2 위반).

| 선택 | 언제 | 본 스킬 적용 |
|---|---|---|
| Epic → Story | 서브이슈가 독립 PR로 나가고 독립 작업자(사람·AI)에게 할당됨 | ✅ 대상 |
| Story → Sub-task | 단일 PR 범위 안의 체크리스트 | ❌ 스킬 대상 아님 |

- legacy `Epic Link` 커스텀 필드는 **deprecated** → `parent` 필드로 통합 (custom field ID는 사이트마다 다름 — 하드코딩 금지).

```bash
curl -u $EMAIL:$API_TOKEN "https://$SITE/rest/api/3/issuetype"
```

ref: <https://support.atlassian.com/jira-cloud-administration/docs/configure-the-issue-type-hierarchy/> · <https://support.atlassian.com/jira-software-cloud/docs/upcoming-changes-epic-link-replaced-with-parent/>

## 2. Epic → child 생성 / 조회

```bash
# 생성 (parent로 에픽 연결)
curl -X POST "https://$SITE/rest/api/3/issue" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"project":{"key":"PRJ"},"parent":{"key":"PRJ-10"},"summary":"phase 1","issuetype":{"name":"Story"}}}'

# 조회 (JQL) — /search는 deprecated, /search/jql 사용
curl -X POST "https://$SITE/rest/api/3/search/jql" \
  -H "Content-Type: application/json" \
  -d '{"jql":"parent = PRJ-10","fields":["summary","status"]}'
```

ref: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post> · <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post>

## 3. Workflow transition + resolution

전이에서 지정 가능한 필드는 **transition screen에 노출된 것만**. screen에 없는 `resolution`을 보내면 실패. `expand=transitions.fields`로 먼저 허용 필드 조회.

```bash
# 허용 필드 포함 전이 조회
curl -u "$EMAIL:$API_TOKEN" \
  "https://$SITE/rest/api/3/issue/PRJ-1/transitions?expand=transitions.fields"

# 전이 실행 — 응답의 transitions[].fields에 노출된 것만 보냄
curl -X POST "https://$SITE/rest/api/3/issue/PRJ-1/transitions" \
  -H "Content-Type: application/json" \
  -d '{"transition":{"id":"31"}}'
```

resolution은 workflow의 post-function/transition screen이 관리하는 게 안전. 강제로 넘기면 project/workflow별로 실패.

ref: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-transitions-post> · <https://support.atlassian.com/jira/kb/best-practices-on-using-the-resolution-field-in-jira-cloud/>

## 4. Epic close — 수동 전이 (자동화 금지)

**경고:** Atlassian Automation 템플릿 "Transition parent when all children complete"는 이 스킬과 **충돌**. 모든 child가 Done이 되는 순간 에픽을 전이시키므로 P4의 체크박스 tick + Done-Done 검증 단계를 우회함 (Invariants 위반).

이 스킬 적용 프로젝트에서는:
- 해당 자동화 규칙을 **disable**.
- 에픽 close는 P4 순서 그대로 수동 전이: children close → checkbox `[x]` → Done-Done 검증 → open children 0 확인 → epic transition.

JQL로 open children 0 검증:

```bash
curl -X POST "https://$SITE/rest/api/3/search/jql" \
  -H "Content-Type: application/json" \
  -d '{"jql":"parent = PRJ-10 AND statusCategory != Done","fields":["summary"]}'
# 결과 issues[]가 비어야 epic close 가능
```

ref: <https://support.atlassian.com/automation/kb/how-to-transition-the-parent-epic-to-done-status-automatically/> (대조용 — 본 스킬에서는 사용하지 않음)

## 5. JQL 팁

```
parent = PRJ-10                # 직속 자식
parentEpic = PRJ-10            # 에픽 하위 전체 (sub-task 포함)
statusCategory != Done AND parent = PRJ-10   # 미완 children
```

ref: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/>

## 6. Jira 특유 필드

- **`Components`** — 모듈/영역 scope 표현. 에픽·서브이슈 공통.
- **`Definition of Done`** 필드가 프로젝트에 있으면 에픽 description의 "Done-Done" 섹션 대신 사용 가능.

라벨 정책(phase 라벨 금지 / 상태 라벨은 서브이슈에만)은 SKILL.md Invariant 6.

## 7. 인증

```bash
curl -u "$EMAIL:$API_TOKEN" "https://$SITE/rest/api/3/myself"
```

Cloud: Basic auth `email:api_token` 또는 Forge OAuth.
