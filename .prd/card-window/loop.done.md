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
