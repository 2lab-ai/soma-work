# card-window — done (append-only)

Loop: [`loop.md`](loop.md) · 라운드를 닫을 때마다 맨 아래에 블록 하나를 붙인다. 위쪽은 바꾸지 않는다(using-dotprd `scripts/loop-lint.py` C2가 git 기준으로 확인).
행은 옮긴 시점의 스냅샷이다. 나중 재측정 통과는 loop.md 라운드 절의 `re-verified` 줄, 실패는 loop.md 새 행(Source `regression:<ID>`).

## R1 — closed 2026-11-18

- measured WU1✅ WU2✅ WU3✅ WU4✅ G1✅ · result: 작업 카드 머리의 − · 제목 · ▽ 창 버튼, 상세 카드 ⇔ 한 줄, 한 줄 TL;DR, 하루 지난 즐겨찾기 한 줄이 dev v0.3.79 `0a2476cf`에서 배포 빌드 리시트 34/34 · closed rows: WU1, WU2, WU3, WU4, G1 · commit/PR: https://github.com/2lab-ai/ui/pull/84 (`cc51d50`, npm `@2lab.ai/ui@0.43.0`), https://github.com/2lab-ai/soma-work/pull/1349 (`0a2476cf`)

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|
| WU1 | ssot T2–T5 · T8 | 라이브러리 `<ui-agent-inbox>` 창 버튼(opt-in `controls: 'window'`), 상태 셋, ▽ 점프 · 먼지 | 34 §3 · §5 1–4 · 9 · 10 | 면 전체가 `role="button"` 하나(34 §1) | ✅ | — | `2lab-ai/ui` PR #84 | `npm run verify` 2,605 통과, RED→GREEN 13 · 4 · 1. 머지 `cc51d50`, npm 0.43.0(오너 배포, shasum 679dce01, gitHead cc51d50) | 2026-11-18 ui `cc51d50` |
| WU2 | ssot T1 · T6 · T7 | soma-work 연결: 제목 → 상세 카드 + 한 줄, ✕ → 원래대로, 저장, 결정 대기 카드(D9) | 34 §4 · §5 4–7 | `wireInbox` 면 누름 → 제자리 펼침 + `openPanel` 동시(34 §1) | ✅ | — | soma-work PR #1349 (astra 1회 + Review of Legends 5회) | `src/conversation/__tests__/` 206 파일 4,367 통과, 대시보드 테스트 RED 15 → GREEN, 리뷰 지적 RED→GREEN(결정의 펼침은 + 아님, 저장 순서, 덱 앞 카드, 앞 바뀐 뒤 결정, 결정이 푼 덱 카드는 다시 그려도 펼친 채 — 5회 지적은 마감 PR `67b012ab`) | 2026-11-18 main `0a2476cf` |
| WU3 | ssot T1–T7 · T10 · T11 | 실브라우저 리시트 | 34 §6 표 | — | ✅ | — | `scripts/screenshot-card-window.ts` | 로컬 34/34(npm 0.43.0), dev 배포 빌드 34/34(34 §7) | 2026-11-18 dev v0.3.79 |
| WU4 | ssot T10 · T11 (SSOT_2) | 한 줄 카드의 TL;DR, 하루 지난 즐겨찾기 한 줄 + TL;DR | 34 D11 · D12, §6 11 | 한 줄에 TL;DR 없음, 즐겨찾기는 늘 보통 크기 | ✅ | — | WU1 · WU2와 같은 PR | 라이브러리 `.ib-min-tldr` RED 1 → GREEN, soma-work `cardMinSeeds` · `cardStarDefaultFolded` · `soma-card-unfold` RED 5 → GREEN, 리시트 S11 | 2026-11-18 dev v0.3.79 |
| G1 | 구현 중 발견 | `@2lab.ai/ui` 0.43.0 npm 배포 | soma-work가 0.43.0을 설치 | private 레포 · org 결제로 `publish.yml` 러너가 돌지 않음, 이 머신에 npm 로그인 없음 | ✅ | — | 오너 작업(npm 로그인된 기기에서 깨끗한 클론 → 빌드 → `npm publish`) | npm `@2lab.ai/ui@0.43.0` gitHead `cc51d50`, soma-work `package.json` · lock 0.43.0(`29fb50fc`) | 2026-11-18 |

### Round section (as it was in loop.md)

## 라운드 1 — 계획 (2026-11-18)

| ID | 단위 | Status | 브랜치 · 워크트리 | 스코프 · 지금 |
|---|---|---|---|---|
| WU1 | 라이브러리 창 버튼 | ✅ | `2lab-ai/ui` `feat/agent-inbox-window-controls` | `src/components/agent-inbox/{agent-inbox,styles,docs,agent-inbox.test}.ts`, 0.43.0. PR https://github.com/2lab-ai/ui/pull/84 — `npm run verify` 녹색(2,605), RED→GREEN 13 · 4 · 1. **머지됨 2026-11-18 `cc51d50`**, npm `@2lab.ai/ui@0.43.0` 배포됨(오너, shasum 679dce01, gitHead cc51d50) |
| WU2 | soma-work 연결 | ✅ | `2lab-ai/soma-work` `feat/task-card-window-controls` | `dashboard.ts`(inboxPaint · wireInbox · openPanel · deckRemove · closePanel · closeDetailCard · 딥 링크 · 새 작업 카드 · autoOpenDecisions), 하네스 seam, 테스트 갱신. 대시보드 테스트 RED 15 → GREEN. PR https://github.com/2lab-ai/soma-work/pull/1349 머지 `0a2476cf`. `@2lab.ai/ui` 0.43.0 올림(package.json · lock) |
| WU4 | SSOT_2 — 한 줄 TL;DR · 하루 지난 즐겨찾기 | ✅ | WU1 · WU2와 같음 | 라이브러리 `.ib-min-tldr`(RED 1 → GREEN), soma-work `cardMinSeeds` · `cardStarDefaultFolded` · `soma-card-unfold`(RED 5 → GREEN). 스펙 D11 · D12 |
| WU3 | 실브라우저 리시트 | ✅ | WU2와 같음 | `scripts/screenshot-card-window.ts` 로컬 34/34(1440 보드 · 다크 감소된 모션 · 1280 목록 · 390 폰 · 즐겨찾기 TL;DR · 검색 · 키보드 포커스), dev 배포 빌드 34/34(34 §7) |

리뷰: astra 1회(P0 없음, P1 = G1, P2 7건 반영 — 한 줄 카드의 상태 점, 초기 접힘은 한 번, TL;DR × 뒤 포커스, 새 결정이 접힌 카드를 펼침, ‹ ›로 돌아온 카드를 다시 접지 않음, 다시 그려도 덱의 접힘 유지, 상세 카드를 닫으면 제목으로 포커스). Review of Legends 5회: 1회 7건 · 2회 · 3회(P1 덱 앞 카드의 결정은 보드 카드를 건드리지 않음, P1 결정의 펼침은 사람의 +가 아님) · 4회(필수 통과, P2 저장 순서 · 앞 바뀐 뒤 결정 테스트 반영, 탭 사이 경쟁은 34 D8에 근거, P3 선택자 대체는 ES5 클라이언트라 안 함) · 5회(필수 통과, 모든 에이전트 "patch is correct". P2 다시 그림 테스트 · `boardDetailInFront` → `boardCurrentKey() === key`는 마감 PR `67b012ab`, 실패한 쓰기 뒤 맞추기는 탭 사이 경쟁과 같은 근거).

결과: ui #84 `cc51d50` 머지 → 오너 npm 0.43.0 배포(G1) → soma-work #1349 0.43.0 올림 · ready → 리뷰 5회 → 머지 `0a2476cf` → dev 배포 run https://github.com/2lab-ai/soma-work/actions/runs/44264502709 (dev 호스트 한 대) → 배포 빌드로 리시트 34/34(34 §7). 남은 것: G2(detail-deck 리시트의 옛 셀렉터, 이 변경 전부터) — loop.md.

## R2 — closed 2026-11-18

- measured WU5✅ WU7✅ WU6✅ · result: 남의 작업 카드는 한 줄로 시작하고 사람의 −/+는 새로 고침을 넘어 유지(SSOT_3, D13) · 앞에 보이는 상세 카드의 카드만 한 줄, 앞이 바뀌면 그 전 카드는 원래 모습(SSOT_4, D7) · dev v0.3.81 `abb592f9` 배포 빌드 리시트 45/45 · closed rows: WU5, WU6, WU7 · commit/PR: https://github.com/2lab-ai/soma-work/pull/1355 (`df0fa25d`), https://github.com/2lab-ai/soma-work/pull/1358 (`abb592f9`), 마감 PR(이 블록)

### Closed rows

| ID | Source | Universe Item | Observable Acceptance | AS-IS Evidence | Status | Gap | Dispatch | Verification Evidence | Last Measured |
|---|---|---|---|---|---|---|---|---|---|
| WU5 | ssot T12 · T13 (SSOT_3) | 남의 카드 기본 한 줄, 사람의 −/+ 저장 · 새로 고침 유지, 안 건드리면 기본 | 34 D13, §6 S15 | 남의 카드도 82px 보통으로 시작(v0.3.79에서 S15 6개 실패) | ✅ | — | PR #1355 (Review of Legends 2회: 보는 사람이 바뀌면 양쪽으로 맞추기 · 게이트 리시트 · 시험 보강) | 단위 RED 4 → GREEN, 계정 바뀜 시험(변이 확인). 리시트 S15 9/9. dev v0.3.80 `ac6ac5fe`(다른 세션이 09:21 배포, #1355 포함): S15 9/9 — 남의 카드 42px · 내 카드 118px, + → 82px 저장 · 새로 고침 유지, − 저장 · 새로 고침 42px, `/auth/me` 늦게 + 상세 카드 열림 → ✕ 뒤에도 한 줄, 주인으로 로그인 → ✕ 뒤 82px | 2026-11-18 dev v0.3.80 `ac6ac5fe` |
| WU7 | ssot T14 (SSOT_4) | 다른 카드의 제목 → 앞서 상세 카드로 한 줄이 된 카드는 그 전 모습 | 34 D7(바뀜), §5 5, §6 S5 · S13 | 덱의 모든 카드가 한 줄(v0.3.79 · v0.3.80에서 S5 · S13 실패) | ✅ | — | PR #1358 (Review of Legends 1회: 뒤 카드 계정 바뀜 시험은 마감 PR `777a71a1`) | 단위 `boardSyncDetailFold` · 앞만 다시 그림 · 덱 세계(제자리로 펼친 카드는 펼친 채로, 사람의 −는 그대로, ‹ ›) RED → GREEN. 리시트 S5: 둘째 제목 뒤 첫 카드 241px(펼친 채로 돌아옴). 배포 빌드 45/45 | 2026-11-18 dev v0.3.81 |
| WU6 | — | dev 배포 · 배포 빌드 실측 | 배포 증명 + 리시트 전부 | — | ✅ | — | run https://github.com/2lab-ai/soma-work/actions/runs/44277138972 (dev 호스트 한 대) | `Deploy t3` 하나(dev 호스트 한 대) · `Verify` 성공 · 설치본 `version.json` commitHash = 머지 `abb592f9` · 번들의 `@2lab.ai/ui` 0.43.0 · 재시작 줄 `bot is running! [v0.3.81 (abb592f)]` 뒤 세션 시작 3개(서로 다른 sessionId), 거절 0. | 2026-11-18 dev v0.3.81 |

### Round section (as it was in loop.md)

## 라운드 2 — 계획 (2026-11-18, SSOT_3 · SSOT_4)

AS-IS(실측, main `0a2476cf`): 남의 카드도 내 카드와 같이 보통 크기로 그려진다(`cardMinSeeds`는 사람의 − 와 하루 지난 즐겨찾기만). `/auth/me`는 보드와 따로 오고, 요소는 한 번 본 카드의 시작 접힘을 다시 읽지 않는다(`@2lab.ai/ui` `#minSeen`) — 보는 사람을 늦게 알면 시드만으로는 접히지 않는다. 덱의 모든 상세 카드의 카드가 보드에서 한 줄이었다(D7 라운드 1).

| ID | 단위 | Status | 브랜치 · 워크트리 | 스코프 · 끝상태 확인 |
|---|---|---|---|---|
| WU5 | 남의 카드 기본 한 줄 + 저장(D13) | ✅ | `feat/card-window-others-fold` · PR #1355 머지 `df0fa25d` | `dashboard.ts` `cardOthersDefaultFolded` · `cardMinSeeds` · `boardOwnerDefaults`(양쪽, 리뷰) · `_applyUserPill`, 시험 하네스 seam. 단위 RED → GREEN, 리시트 S15 |
| WU7 | 앞 상세 카드만 한 줄(D7, SSOT_4) | ✅ | `feat/card-window-front-only` · PR #1358 머지 `abb592f9` | `dashboard.ts` `boardSyncDetailFold` · `boardFoldDeck`(앞만) · `openPanel` · `closePanel` · `boardOwnerDefaults`(앞), 결정의 `_detailUnfolded` 제거. 덱 시험 갱신, 리시트 S5 · S6 · S13. #1355 리뷰 2회 시험 보강 |
| WU6 | dev 배포 · 배포 빌드 실측 | ✅ | WU5 · WU7 머지 뒤 | run https://github.com/2lab-ai/soma-work/actions/runs/44277138972 → 배포 번들로 리시트 45/45 |

리뷰: #1355 Review of Legends 2회(1회 P2 4건 — 보는 사람이 바뀌면 남의 카드 기본을 양쪽으로 맞춤 3건 · 늦은 인증 리시트 게이트 1건, 모두 반영. 2회 P2 2건 · P3 2건은 시험 · 정리라 #1358에서: 저장된 − 순서, 표시 모델 페이크, 겹치는 덮어쓰기 제거. P3 seam 제거는 안 함 — 진짜 `cardMinSeeds`를 부르는 묶음 넷이 깨진다). #1358 1회(P2 2건 · P3 1건 — 뒤 카드 계정 바뀜 시험과 남은 단언 정리는 마감 PR).

결과: SSOT_3 → #1355 `df0fa25d` 머지(다른 세션의 dev 배포 v0.3.80에 들어가 S15 9/9) → SSOT_4 → #1358 `abb592f9` 머지 → dev 배포 run https://github.com/2lab-ai/soma-work/actions/runs/44277138972 → 배포 빌드 리시트 45/45(34 §7).
