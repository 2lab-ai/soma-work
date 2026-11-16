# loop — code-changes 구현 드라이브

Status: done (라운드 1 · 2 닫힘) · 열린 gap = G1–G3 · G5 · G10 · G14 🚪, 리뷰 리포트(2026-11-16)의 G6–G9 · G11–G13 🔴🟡 — 근거 [`../research/2026-11-16-code-changes-review.md`](../research/2026-11-16-code-changes-review.md) · 스펙 = [`../26-session-code-changes-spec.md`](../26-session-code-changes-spec.md) ·
아키텍처 = [`../27-session-code-changes-architecture.md`](../27-session-code-changes-architecture.md) · ssot = [`ssot.md`](ssot.md) ·
끝난 것 = [`loop.done.md`](loop.done.md)

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | 저장 문서의 정리(삭제) 정책 없음 — 대화 삭제 · 보관 기간 | 🚪 | 문서 하나 ≤ 6 MiB 상한만 있음. 대화 삭제와 같이 지우는 길을 정한다 |
| G2 | 세션 폴더 밖 체크아웃은 안 보인다 | 🚪 | 비목표(26 §2). 요청이 오면 재조정기와 같이 넓힌다 |
| G3 | 닫힌 세션의 PR이 닫힌 뒤 머지되면 머지 줄에 안 잡힌다 | 🚪 | PR 감시는 살아 있는 세션만 본다. 저장 문서를 도는 주기 확인이 필요하면 그때 |
| G5 | 카드의 지난 PR 칩이 머지 뒤에도 "열림"으로 남는다(dev 2026-11-16: #1299 · #1300 · #1301) — 변경점 탭은 "머지됨"으로 맞다 | 🚪 | 이 기능 밖: 세션 PR 감시(#928)는 현재 PR만 본다. 변경점 저장본의 PR 상태로 링크 기록을 고치거나 감시를 넓힌다 |
| G6 | 세션 시작 전에 만든 PR에 이어 커밋하면 그 커밋이 "PR에 없는 커밋"으로 잡힌다 — 세션 전 PR의 head가 `committedBase` 기준점 후보에서 빠진다(`pr-changes.ts`의 `continue`). 리뷰 리포트 F1 | 🔴 | 세션 전 PR의 head(와 head 저장소)를 기준점 후보로만 남긴다. PR · 머지됨 층과 지표에서는 계속 뺀다 |
| G7 | amend와 충돌을 푼 merge가 커밋 지표를 부풀린다 — reflog의 `commit (amend)` · `commit (merge)`를 새 커밋으로 센다(두 번 amend → 3행, 153줄, 실제 52줄). F2 | 🔴 | amend는 바꾼 커밋 대비 차이만 세고 `commit_created`를 새로 내지 않는다. 충돌 merge는 해결분만(`--remerge-diff`) 세거나 세지 않는다 |
| G8 | `.git` 안이 정리되는 중(gc · prune)에 읽으면 "링크가 있다"로 오판하고 지난 읽기까지 지운다 — `noLinksIn`이 링크 · 사라짐 · 10만 초과에 같은 `false`(재현 104번 중 92번). F3 | 🔴 | 결과를 셋으로 나눈다: 링크 → 거부, 사라짐 → `repo-changed-during-read`(지난 읽기 유지), 초과 → 고유 사유와 문구 |
| G9 | PR 상한 20개를 본문에 언급된 남의 PR 링크가 채운다(`seen.size`) — 세션의 머지된 PR이 저장본에서 밀려난다. F4 | 🔴 | 세션 PR이 아닌 id를 기억해 건너뛰고, 상한은 세션 PR에만 적용한다 |
| G10 | 큰 저장소 비용 — 커밋 안 함 층이 추적 파일마다 stat(4만 파일 cold 9.0 s · warm 0.7 s), 캐시는 메모리뿐. F5 | 🚪 | 실제 큰 저장소 세션이 생기면 측정부터. 그다음 git index stat(racy 규칙), 병렬 lstat 상한, 수집 시간 예산 |
| G11 | 내용이 같아도 수집마다 저장본을 다시 쓴다(`updatedAt` · `.bak` · 카드 푸시, 1.9 MB에 동기 I/O 12 + 14 ms). 클라이언트 쪽(열린 뷰어가 비고 튐)은 #1313에서 고쳤다. F6 | 🟡 | 내용 해시가 같으면 쓰지 않고 "확인 시각"만 따로 둔다 |
| G12 | 잘림과 오래됨을 화면이 말하지 않는다 — 층 1,000파일 상한, PR 300파일 잘림(행 "파일 500" · 트리 300), `filesStale`, 기준 시각 HH:MM뿐, 새로 고침의 바쁨 표시 없음 · 닫힌 세션에서 조용히 무동작. F7 | 🔴 | 잘림 · 오래됨 줄, 날짜가 있는 기준 시각, 새로 고침 상태 표시 |
| G13 | 탭을 열 때마다 `refresh=1`로 전체 수집(GitHub 호출 포함), 서브에이전트를 바꿔도 다시. F8 | 🔴 | 저장본이 N초보다 오래됐을 때만 다시 모은다 |
| G14 | 배포 전 명령 출력 파서가 만든 가짜 커밋 지표 6행이 남아 있다(테스트 픽스처 `[main abc1234] …`) — 스펙대로 지우지 않았다 | 🚪 | 원하면 sha가 실제로 없는 `commit_created` 행을 지우는 1회 정리 |

## build facts (실측)

- 클론 직후: `npm ci` → `npm run build:packages` → `npm run build:somalib` → `npx vitest run <files>`.
- dashboard.ts를 import하는 라우트 테스트는 첫 변환이 ~30 s — 로컬은 `--hookTimeout 120000`.
- i18n: `npx tsx scripts/i18n/extract.ts --write` → `scripts/i18n/out/missing-page.json`을 main과 diff.
- CI quality-gates의 lint 범위는 `biome check src/ somalib/ scripts/ packages/` — 일부 폴더만 돌리면 포맷 오류를 놓친다.
- dev 실측 화면: 배포 빌드(`/opt/soma-work/dev/dist`)를 scratch `SOMA_CONFIG_DIR` 아래에서 띄우고 dev 저장본(`code-changes/<대화 id>.json`)과 세션 줄을 복사해 넣는다 — 배포의 토큰 · 데이터는 읽기만 하고 쓰지 않는다. 카드 안 링크를 누르면 링크 뷰어가 열리니 카드 면은 포커스 + Enter로 연다.
- 호스트 부하가 높으면(load 40) git을 여러 번 부르는 시험이 기본 5초를 넘긴다 — 실패가 타임아웃인지 먼저 본다.
