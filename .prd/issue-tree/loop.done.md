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

## R2 — closed 2026-11-17

- measured G1✅ G2✅ G3✅ G4✅ · result: a PR state follows the newest read (a slower, older read cannot flip closed back to open; a merge is always taken); a full stored tree of PRs only stays within the cap (the oldest host PR nothing depends on gives way to the seed; with none, nothing is removed and the seed is the one node over, kept on load); a rendered PR row, clicked, shows that PR's files only; a merged PR record from before .prd/29 is read once for its closing refs (files reused); dev `74a89fa3` · closed rows: G1, G2, G3, G4 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1324 (`74a89fa3`)

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|
| G1 | ssot T29 (SSOT_5) | PR 상태 읽기 순서 | 늦게 도착한 옛 읽기가 `closed`를 `open`으로 못 돌림, 더 새 읽기는 다시 엶, `merged`는 언제 읽었든 받음 | 리뷰 12라운드 P2 (#1321 스레드 4589990991): 늦은 수집의 `open`이 재조정기의 `closed`를 덮음 | ✅ | — | PR #1324 (리뷰 3라운드: P1 2 · P2 3 · P3 2 반영) | 시험: issue-tree G1(같은 ms 포함) · registry T5d · reconciler R6b · service(재사용 저장본의 옛 시각) — 변이 각각 실패. 배포 somalib(`74a89fa3`): 200에 closed → 150의 open 무시 → 300의 open 적용 → 100의 merged 적용 | 2026-11-17 main `74a89fa3` |
| G2 | ssot T30 | PR만 200개인 저장 트리 | 다시 맞춰도 200, 루트 이슈(시드), 루트 PR 0, 저장·불러오기 왕복에서 더 잃지 않음; 기댄 PR · 모델 자리는 지우지 않음 | 시드가 201번째 → 불러오기에서 마지막 PR이 잘림 (스레드 4589991007) | ✅ | — | PR #1324 | 시험: G2 세 가지(PR만 · 스택+모델 · 관계로만 보호 · 후보 없음=시드가 하나 넘음, 불러오기 유지) — 변이 각각 실패. 배포 somalib: 200 → 200, 시드 루트, 루트 PR 0, 가장 오래된 것 빠짐, 왕복 200 | 2026-11-17 main `74a89fa3` |
| G3 | ssot T31 | 그려진 PR 줄 DOM 시험 | 쌓인(열림) · 중첩(머지) PR 줄을 실제로 누르면 그 PR 파일만, `aria-pressed` 따라감 | 시험이 파일 없는 PR · 범위 id 직접 주입 (스레드 4589991015) | ✅ | — | PR #1324 | DOM D13 — 두 반복문(머지 · 열림 층) 모두 변이 시 실패. CI quality-gates 통과 | 2026-11-17 main `74a89fa3` |
| G4 | ssot T32 | 옛 머지 PR `closes` 1회 재조회 | `closes` 없는 머지 저장본 → 상세 1회로 채움, 파일 다시 안 받음, 다음 수집엔 조회 없음 | 이 세션 #1299–#1301 저장본에 `closes` 없음 → 모델이 직접 옮김 (29 §9 S10) | ✅ | — | PR #1324 | 시험: collector G4 — 변이 시 실패. 배포 빌드 하네스(이 세션 저장본 사본 + 미리 받은 PR 상세): 상세 4회 · 파일 0회, #1299→#1295 · #1300→#1296 · #1301→#1297 · #1321→[], 다음 수집 조회 0 | 2026-11-17 main `74a89fa3` |

### Round section (as it was in loop.md)

## 라운드 2 — G1–G4 (SSOT_5, 2026-11-16 열림)

계획: 각 gap을 RED 시험 → 수정 → 변이 확인 → PR 하나 → 리뷰 → 머지 → dev 배포 → 실측(G1 · G4는 이 세션의 실제 트리로) → 닫기.

| ID | gap | Status | 브랜치 · 워크트리 | 끝상태 확인 |
|---|---|---|---|---|
| G1 | PR 상태 읽기 순서 | ✅ | `fix/issue-tree-g1-g4` · `wt-tree` · PR #1324 머지 `74a89fa3` | 늦게 도착한 옛 읽기가 `closed`를 `open`으로 못 돌림, 더 새 읽기의 재오픈은 됨 (시험) |
| G2 | 꽉 찬 PR만의 트리 | ✅ | 같은 브랜치 | 200개 PR만의 저장본 → 다시 맞춰도 200, 루트 이슈 있음, 저장·불러오기 왕복에서 더 잃지 않음 (시험) |
| G3 | 그려진 PR 줄 DOM 시험 | ✅ | 같은 브랜치 | 중첩 · 쌓인 PR 줄을 눌러 그 PR 파일만 (DOM 시험) |
| G4 | 옛 머지 PR `closes` 1회 재조회 | ✅ | 같은 브랜치 | `closes` 없는 머지 저장본 → 상세 1회 조회로 채움, 파일은 재사용, 다음 수집엔 조회 없음 (시험 + dev: 이 세션 #1299–#1301의 관계를 호스트가 배움) |

결과: PR #1324 — 리뷰 3라운드(1라운드 P1 2: 기댄 PR을 지우던 대체 경로, 늦게 읽힌 머지 거부 → 수정; 3라운드 P2 같은 ms 시험은 이 닫기 PR에) → 머지 `74a89fa3` → dev 배포(owner-mac) → 배포 빌드로 G1 · G2 · G4 확인. 살아 있는 이 세션의 저장본은 배포 뒤 첫 수집(턴 끝)에서 #1299–#1301 · #1321을 한 번 다시 읽는다.
