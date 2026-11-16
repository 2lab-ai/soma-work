# code-changes — done (append-only)

Loop: ./loop.md · Each round close appends one block at the bottom; nothing above it ever changes (the using-dotprd skill's `scripts/loop-lint.py` C2 compares against git). Rows here are snapshots (Last Measured frozen at move time). A later pass is a `re-verified` line in a loop.md round section; a regression reopens as a new loop.md row with Source `regression:<ID>`.

## R1 — closed 2026-11-16

- measured WU1✅ WU2✅ WU3✅ G4✅ · result: the four layers are collected, stored, shown and counted; main `d29a3fc6` · closed rows: WU1, WU2, WU3, G4 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1299 (`29c4435c`), https://github.com/2lab-ai/soma-work/pull/1300 (`36fd1598`), https://github.com/2lab-ai/soma-work/pull/1301 (`1ac87877`), https://github.com/2lab-ai/soma-work/pull/1302 (`d29a3fc6`)

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|
| WU1 | ssot T6 · T2 · T3 | 수집 · 저장 · 라우트 · 턴 끝 배선 · 요약 영속 | 27 §8 WU1 | 변경 데이터 없음 | ✅ | — | #1295 · PR #1299 (리뷰 8회: 독립 1 + Review of Legends 7) + #1302(남은 지적) | `src/code-changes/__tests__` (checkout-changes 61 · collector 26 · service 11), 라우트 4, 재조정기 R13, 전송 계층 4 — 새 테스트 전부 변이 확인; CI quality-gates · lean-verify · scan · review-of-legends/required 녹색 | 2026-11-16 main `d29a3fc6` |
| WU2 | ssot T1 · T4 · T5 | 변경점 탭 · 트리 · 전체 화면 뷰어 · i18n | 27 §8 WU2 + 실서버 스크린샷 | 탭 없음 | ✅ | — | #1296 · PR #1300 | `code-changes-client` 11 + DOM(happy-dom) 10, 대시보드 전체 4,171 통과; 실서버 하네스(Playwright) 한 · 영 · 폰 스크린샷(PR #1300 본문) | 2026-11-16 main `36fd1598` |
| WU3 | ssot T7 · T8 | 통계(고정 id · 파서 제거 · PR 감시 재수집) · GET_SESSION · 턴 컨텍스트 | 27 §8 WU3 + dev 지표 실측 | 통계의 코드 변경이 명령 출력 파싱 | ✅ | dev 지표 실측은 R2 | #1297 · PR #1301 | metrics 17, collector · store · event-store 테스트, stream-executor · catalog · host-receipt 테스트; 변이 확인 | 2026-11-16 main `1ac87877` |
| G4 | 27 §5 | 경로 구성 요소를 링크로 바꿔치는 경쟁(검사 뒤 · git 호출 전) | 바꿔치기로 세션 밖 내용이 저장되지 않는다 | 남는 위험으로 문서화돼 있었다 | ✅ | — | PR #1299 4–7차 | `readInside`(O_NOFOLLOW_ANY · /proc/self/fd) + `PathWitness`(ctime) + 게이트 재질문 + alternates 확인 순서 — 공격 시험 4개(.git 교체, linked worktree 교체, commondir 재작성, alternates 심기)가 확인을 빼면 새고 넣으면 막힌다 | 2026-11-16 main `d29a3fc6` |

### Round section (as it was in loop.md)

## 라운드 1 — 문서 · 에픽 · WU1 → WU3 → WU2 (2026-11-16 열림)

계획: 이 문서들을 WU1 PR에 싣는다 → 에픽 #1294 + 서브이슈 #1295–#1297 (만듦, 2026-11-16) → WU1(서버) 머지 → WU3(통계 · 모델)과 WU2(화면)를 WU1 위에서 → dev 배포 → 실측.

결과: WU1 #1299(`29c4435c`) → WU2 #1300(`36fd1598`) → WU3 #1301(`1ac87877`) → WU1 후속 #1302(`d29a3fc6`) 머지. 리뷰에서 나온 안전 지적(경로 바꿔치기, 루트 고정, 실패를 "없음"으로 읽기, 지표 전달 재시도)을 모두 코드와 시험으로 닫았다. dev 배포는 배포 워크플로의 태그 push 403으로 막혀 R2로 넘긴다(우회 https://github.com/2lab-ai/soma-work/pull/1307).
