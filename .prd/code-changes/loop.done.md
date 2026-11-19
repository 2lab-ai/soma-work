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

## R2 — closed 2026-11-16

- measured D1✅ · result: dev runs the four layers, the 변경점 tab and file viewer, the fixed-id metrics and the model's view; two defects dev showed were fixed and measured again · closed rows: D1 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1307 (`be65858b`), https://github.com/2lab-ai/soma-work/pull/1309 (`cda9d40a`)

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|
| D1 | loop R2 | dev 배포 · 실측 | 변경점 탭 스크린샷 · `session.codeChanges` · `merge_lines:` · `commit:` 행 | 배포 prepare의 태그 push 403(03:37 UTC부터) | ✅ | — | #1294 · PR #1307 · PR #1309 | v0.3.54-dev(`be65858b`) → v0.3.56-dev(`cda9d40a`). 머지 줄 6행(#1299 #1300 #1301 #1302 #1307 #1309, id `merge_lines:<PR URL>`) = GitHub additions/deletions(#1309 +73/−12). 커밋 줄 3쌍(`commit:` · `commit_lines:` c4d7f287 +42/−11, da8bb1c1 +4/−1, e34c8ee6 +27/−0) = `git show --numstat`, 경계(`.counting-since.json`) 전 커밋은 세지 않음. GET_SESSION `session.codeChanges`, 다음 턴 `<context>`의 `<uncommitted-changes>` 줄. 배포 빌드 + dev 저장본 사본으로 탭 · 뷰어 스크린샷(1440 · 390). dev가 보여 준 결함 2개 — 커밋함 기준점이 머지된 PR head라 남이 main에 머지한 파일이 섞임, 폰 뷰어 머리줄의 `+24`가 세로로 꺾임(11.8px × 52px) — 는 #1309로 고쳤다. 다시 잼(v0.3.56-dev 배포 코드): 같은 체크아웃의 커밋함 층이 남의 #1306 파일 5개 · 커밋 7개 → 이 세션의 `loop.md` · `loop.done.md`와 커밋 1개(기준점 = origin/main `cda9d40a`); 폰 머리줄 `+24`는 22.7px × 17.4px 한 줄, 영어 화면의 한글은 PR 제목 · 파일 내용(데이터)뿐. | 2026-11-16 main `cda9d40a` |

### Round section (as it was in loop.md)

## 라운드 2 — dev 배포 · 실측 (2026-11-16 열림)

계획: main(`d29a3fc6` 이후)을 dev에 배포 → 대시보드 변경점 탭 · `GET_SESSION` `session.codeChanges` · 고정 id 지표 행을 실서버에서 확인 → 번호 문서를 shipped로.

결과: 태그 push 403은 #1307(dev는 태그 없이 계속)로 넘겼다. dev 실측에서 결함 2개가 나와 #1309로 고치고 다시 배포 · 측정했다. 26 · 27 · ssot는 shipped.

## SSOT_6 · SSOT_7 (2026-11-17 · 2026-11-19)

| 요청 | PR | 실측 (dev) |
|---|---|---|
| SSOT_6 "다른 사람의 작업도 변경점 읽을수 있게 해줘" | https://github.com/2lab-ai/soma-work/pull/1326 | v0.3.68-dev: 다른 사용자 — 공개 작업 200(목록 · 파일), DM · 비공개 채널 작업 404; 오너 200. 다른 사용자로 연 탭에 트리 23줄 · 파일 94 |
| SSOT_7 "이세션 뭐야 pr 만 나오고 변경점 코드가 안나옴" — 비공개 레포(호스트 토큰 404)의 머지된 세션 PR | https://github.com/2lab-ai/soma-work/pull/1371 (리뷰 6라운드) | v0.3.89: dosi.dev 세션 — 전에는 `prs: []` · 파일 0. 배포 빌드로 다시 수집(GitHub 무응답 그대로): PR #65–#71이 클론의 머지 커밋에서 읽힘, 레포 1 · 파일 305 · +242827 −23034, #65 파일 290 중 패치 96(코드 파일 19/19), #66 274 중 111(코드 12/12), 나머지 전부. #72는 GitHub에서 머지됐으나 클론이 fetch 전이라 "읽지 못함" + 이유(그 브랜치 변경은 커밋함 층 6파일) |

- 범위를 줄인 결정(#1371 5차): 스쿼시 · 리베이스 머지는 클론에서 읽지 않는다 — 세션의 스쿼시를 같은 번호의 다른 스쿼시와 가리는 방법(제목 · 파일 수 · 내용)이 라운드마다 새 예외로 깨졌다. 그런 PR은 "읽지 못함"과 이유.
- 남은 6차 P2 → loop.md G15–G20.
