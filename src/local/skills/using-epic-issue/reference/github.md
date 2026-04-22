# GitHub issue reference — using-epic-issue 부속

GitHub로 에픽+서브이슈를 구현할 때의 문법/API. 에이전트가 복사해서 쓰는 용도.

## 1. Sub-issue 관계 성립 (2024-12 GA)

**경고:** body의 `Part of #N` / `부분: #N`은 단순 텍스트 reference — 공식 sub-issue 관계가 **아님**. 정식 관계는 REST API 또는 UI "Create sub-issue"로만 성립.

```bash
gh api -X POST repos/OWNER/REPO/issues/<epic>/sub_issues \
  -f sub_issue_id=<child_issue_db_id> -F replace_parent=false
```

- Parent당 **최대 100** sub-issues. 깊이 **최대 8**.
- 필요 권한: Issues **Read & write** (Fine-grained PAT 또는 GitHub App).
- Header: `X-GitHub-Api-Version: 2022-11-28`.

ref: <https://docs.github.com/en/rest/issues/sub-issues> · <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues>

## 2. Task list (체크박스)

```md
- [ ] #123 phase 1
- [x] owner/repo#45 phase 2
```

Issue 참조는 자동 unfurl. 체크박스 UI 토글 시 body mutation 발생 — Invariant 1 준수 위해 `[ ]↔[x]` 외의 편집 금지.

ref: <https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists>

## 3. PR 머지 시 이슈 자동 close

PR body에 `close[sd] | fix(es|ed) | resolve[sd]` 키워드. **Default branch 머지 시에만** 동작.

```
Closes #12
Fixes owner/repo#34
```

**경고:** 서브이슈 번호만 쓴다. **에픽 번호를 `Closes/Fixes`에 쓰지 않는다** — 에픽은 모든 서브이슈 close 후 사람이 Done-Done 검증하고 수동으로 닫음 (Invariant 4).

ref: <https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/using-keywords-in-issues-and-pull-requests>

## 4. Parent/sub-issue progress 필드 (Projects v2)

Projects v2 뷰에서 `parent-issue`, `sub-issues progress` 필드가 자동 집계. 에픽 보드에 진척률 표시.

ref: <https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields>

## 5. GraphQL sub-issue 트리 순회

```graphql
query($id: ID!) {
  node(id: $id) { ... on Issue {
    title
    subIssuesSummary { total completed }
    subIssues(first: 50) { nodes { id number title state } }
  } }
}
```

ref: <https://docs.github.com/en/graphql/reference/objects#issue>

## 6. Epic close 전 open 서브이슈 0 검증

에픽 close 직전 반드시 실행:

```bash
open_count=$(gh api "repos/OWNER/REPO/issues/<epic>/sub_issues?state=open" --jq 'length')
[ "$open_count" = "0" ] || { echo "open sub-issues remain"; exit 1; }
```

## 7. 라벨 관습

- `epic` — 에픽 식별용. 최초 1회 생성:

```bash
gh api -X POST repos/OWNER/REPO/labels \
  -f name=epic -f color=8B5CF6 \
  -f description="Parent issue aggregating sub-tasks"
```

- **phase별 라벨 지양.** 순서는 에픽의 Checklist 순서가 유일한 source of truth.
- `blocked`, `ready`, `in-progress` 같은 **상태 라벨은 서브이슈에만** 붙인다. 에픽에 붙이면 본문 불변성(Invariant 1)을 우회하는 암묵적 상태가 생긴다.
- 서브이슈 제목에 에픽 번호 프리픽스 불필요 — 네이티브 sub-issue 관계가 UI에서 자동 표시.

## 8. Claude Code Action / GitHub Actions — 에이전트 scope 제한

`@claude` 멘션이나 assignment로 에이전트를 서브이슈에 투입할 때:

- 워크플로 입력(`inputs`)에 **서브이슈 번호만** 전달. 에픽 번호 전달 금지 (context 오염).
- 에이전트의 GitHub token 권한은 해당 서브이슈·PR 범위로 한정. 에픽 본문 편집 경로를 열어두지 않음 (Invariants 1, 5 자동 보호).
- 여러 서브이슈를 병렬로 실행할 경우 서로 다른 branch·worktree 분리. 동일 파일을 건드리는 서브이슈는 직렬로 묶음 (서브이슈 body의 dependency 표기 또는 에픽 Checklist 순서).

ref: <https://docs.github.com/en/actions/security-guides/automatic-token-authentication>

## 9. Rate limit — secondary limits 대응

GitHub 공식 가이드라인:

- `POST`/`PATCH`/`PUT`/`DELETE` mutating 요청은 **직렬화**. 동시 실행 금지.
- mutating 요청 사이 **최소 1초** 간격.
- secondary limit 적중 (`403` 또는 `429`) 처리:
  - `Retry-After` 헤더 있으면 값만큼 대기 후 재시도.
  - `Retry-After` 없으면 **최소 60초** 대기 후 재시도 (GitHub는 모든 secondary-limit 응답에 헤더를 보장하지 않음).
  - 이후 실패 반복 시 **exponential backoff** (ex. 60s → 120s → 240s, 상한 수 분).
- 권한: Fine-grained PAT 또는 GitHub App → Repository permission **Issues: Read & write**.
- Header: `X-GitHub-Api-Version: 2022-11-28`.

ref: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits> · <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
