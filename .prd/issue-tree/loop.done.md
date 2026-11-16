# issue-tree — done (append-only)

Loop: ./loop.md · Each round close appends one block at the bottom; nothing above it ever changes. Rows here are snapshots (Last Measured frozen at move time). A regression reopens as a new loop.md row with Source `regression:<ID>`.

## R1 — closed 2026-11-16

- measured WU1✅ WU2✅ WU3✅ · result: every session keeps an issue tree (external and internal issues, PRs under an issue or a PR, the seed when there is no other root issue); the host places nodes from GitHub (sub-issues, `Closes`, stacks) and rebalances on every write; the model shapes it through MCP `UPDATE_SESSION` (`parent`, `add_internal`, `move`, `remove`); the 변경점 tab draws the collapsible tree in place of the PR list; dev `5069eafe` · closed rows: WU1, WU2, WU3 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1321 (`5069eafe`)

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|
| WU1 | ssot T21–T25 · T27 (SSOT_4 2-1…2-5, 2-7) | 순수 트리 모듈 + UPDATE_SESSION 연산 · 검증기 · MCP 미리보기 | 29 §8 S1–S8 (단위) | 세션에 이슈 트리 없음 — 링크 기록(평평한 목록)뿐 | ✅ | G1, G2 (리뷰 12라운드 P2) | PR #1321 (Review of Legends 12라운드, 스레드 102개 답글) | `issue-tree.test.ts` · `update-session-issue-tree.test.ts` 통과, 수정마다 변이 시험. 29 §9 | 2026-11-16 main `5069eafe` |
| WU2 | ssot T21 · T23–T25 · T27 | 호스트: 저장 · 시드 · 옛 세션 이전 · 링크 자동 기록 · 재조정기 `closes` · 수집의 `base`/본문/이슈 조회 · GET_SESSION · 프롬프트 | 29 §8 S1–S8 (통합) | 변경점 수집은 PR 숫자만, 관계 없음 | ✅ | G1, G4 | PR #1321 | registry T1–T6b · relations · service · reconciler R6b · fetcher 시험 통과. dev: 배포 후 이 세션 트리를 호스트가 링크 기록에서 만들고, MCP 정리가 저장본에 남음(29 §9 S10) | 2026-11-16 main `5069eafe` |
| WU3 | ssot T20 · T26 | 변경점 탭: PR 목록 대신 접히는 이슈 · PR 트리 | 29 §8 S9 · S10 | 변경점 탭 = 평평한 PR 목록 | ✅ | G3 | PR #1321 | client 시험 · DOM D11 · D12. dev 배포 빌드 실측 17줄 · 깊이 0–3 · 접기 1줄 · 포커스 유지 (29 §9) | 2026-11-16 main `5069eafe` |

### Round section (as it was in loop.md)

## 라운드 1 — WU1 · WU2 · WU3 (2026-11-16 열림)

계획: 리서치(끝남 — 링크 모델 · UPDATE_SESSION 경로 · 변경점 PR 수집 · GitHub 관계) → 29 스펙 → WU1(순수 모듈 TDD) → WU2(호스트 배선) · WU3(대시보드) → PR → 머지 → dev 배포 → 이 세션의 트리 실측(29 §8) → 29 shipped.

| ID | WU | Status | 브랜치 · 워크트리 | 스코프 | 끝상태 확인 |
|---|---|---|---|---|---|
| WU1 | 트리 모델 · MCP 연산 | ✅ | `feat/session-issue-tree` · `wt-tree` · PR #1321 머지 `5069eafe` | `somalib/model-commands/`(types · issue-tree · validator · catalog · help), MCP 열거 | 29 §8 S1–S8(단위) |
| WU2 | 호스트 배선 | ✅ | 같은 브랜치 | `session-registry` · `stream-executor` · `session-pr-reconciler` · `code-changes` · `link-metadata-fetcher` · `common.prompt` | 29 §8 S1–S8(통합) |
| WU3 | 변경점 탭 트리 | ✅ | 같은 브랜치 | `dashboard.ts`(`KanbanSession`) · `code-changes-client.ts` · en-page | 29 §8 S9 · S10 |

결과: PR #1321 — 리뷰 12라운드(P1은 11라운드에서 끝, 12라운드는 P2 3개 → G1–G3) → 머지 `5069eafe` → dev 배포(owner-mac) → 이 세션의 실제 트리를 MCP로 정리하고 배포 빌드로 실측(29 §9 S10).
