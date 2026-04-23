# GitHub issue reference — using-epic-tasks 부속

GitHub로 Case B의 에픽+서브이슈를 구현할 때의 문법/API. 플랫폼-중립 규율은 SKILL.md가 소유. Case A 단일 이슈도 이 참조를 사용.

## 1. Sub-issue 관계 성립 (2024-12 GA)

**경고:** body의 `Part of #N` / `부분: #N`은 단순 텍스트 reference — 공식 sub-issue 관계가 **아님**. 정식 관계는 REST API 또는 UI "Create sub-issue"로만 성립.

```bash
gh api -X POST repos/OWNER/REPO/issues/<epic>/sub_issues \
  -f sub_issue_id=<child_issue_db_id> -F replace_parent=false
```

- Parent당 **최대 100** sub-issues. 깊이 **최대 8**.
- 권한: Fine-grained PAT 또는 GitHub App → Repository permission **Issues: Read & write**.
- Header: `X-GitHub-Api-Version: 2022-11-28`.
- Mutating 요청은 **직렬화** + 최소 1초 간격 (secondary limit 대응은 §6).

ref: <https://docs.github.com/en/rest/issues/sub-issues> · <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues>

## 2. Task list (체크박스)

```md
- [ ] #123 phase 1
- [x] owner/repo#45 phase 2
```

Issue 참조는 자동 unfurl. 체크박스 UI 토글 시 body mutation 발생 — SKILL.md Invariant 1 준수 위해 `[ ]↔[x]` 외의 편집 금지.

ref: <https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists>

## 3. PR 머지 시 이슈 자동 close

PR body에 `close[sd] | fix(es|ed) | resolve[sd]` 키워드. **Default branch 머지 시에만** 동작.

```
Closes #12
Fixes owner/repo#34
```

**경고:** 서브이슈 번호만 쓴다. **에픽 번호를 `Closes/Fixes`에 쓰지 않는다** — 에픽은 사람이 Done-Done 검증 후 수동으로 닫음 (SKILL.md Invariant 4).

ref: <https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/using-keywords-in-issues-and-pull-requests>

## 4. Epic close 전 open 서브이슈 0 검증

```bash
open_count=$(gh api "repos/OWNER/REPO/issues/<epic>/sub_issues?state=open" --jq 'length')
[ "$open_count" = "0" ] || { echo "open sub-issues remain"; exit 1; }
```

## 5. 라벨 생성 (최초 1회)

```bash
gh api -X POST repos/OWNER/REPO/labels \
  -f name=epic -f color=8B5CF6 \
  -f description="Parent issue aggregating sub-tasks"
```

라벨 정책(phase 라벨 금지 / 상태 라벨은 서브이슈에만)은 SKILL.md Invariant 6.

## 6. Rate limit — secondary limits 대응

- mutating 요청 사이 **최소 1초** 간격.
- secondary limit 적중 (`403` 또는 `429`) 처리:
  - `Retry-After` 헤더 있으면 값만큼 대기 후 재시도.
  - `Retry-After` 없으면 **최소 60초** 대기 (GitHub는 모든 secondary-limit 응답에 헤더를 보장하지 않음).
  - 실패 반복 시 exponential backoff 60→120→240, 상한 300s.

ref: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits> · <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>

## 7. Claude Code Action — GitHub 전용 mechanics

`@claude` 멘션이나 assignment로 에이전트 투입 시 GitHub 특유 설정:

- 워크플로 `inputs`에 서브이슈 번호만 전달 (에픽 번호 금지).
- `GITHUB_TOKEN` 권한 scope: `issues: write`는 해당 서브이슈에, PR은 해당 브랜치에 한정.

에이전트 행동 규율(컨텍스트 격리·쓰기 권한 제한·병렬 worktree)은 SKILL.md Invariant 7 + Integration.

ref: <https://docs.github.com/en/actions/security-guides/automatic-token-authentication>
