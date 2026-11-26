# loop — work-queue 구현 드라이브

Status: in-progress · 라운드 5 (남은 실측 하나) · 라운드 1–4 닫힘 · ssot = [`ssot.md`](ssot.md) SSOT_1–5 · 스펙 = [`../36-work-queue-spec.md`](../36-work-queue-spec.md) ·
아키텍처 = [`../37-work-queue-architecture.md`](../37-work-queue-architecture.md) · 완료 원장 = [`loop.done.md`](loop.done.md)

## 라운드 5 — 남은 실측 하나

라운드 4는 닫혔다(loop.done.md R4).

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| W17 | 개인 큐 `그래도 시작` 버튼 실클릭(Slack) | 🟡 | 단위 테스트 GREEN(같은 작업 13 · Slack 표면). 실측에는 Slack에 로그인된 브라우저가 필요하다 — 봇이 쓰는 브라우저는 로그인이 풀려 있다(2026-11-26). 소유자가 같은 작업을 두 번 지시해 ⛔ 안내가 뜨면 그때 눌러 확인 |

## build facts

- 패키지 먼저 빌드: `npm run build:packages && npm run build:somalib` (안 하면 `@soma/common/logger`를 못 찾고, somalib 테스트가 옛
  `.js`를 읽는다).
- 게이트: `npx tsc --noEmit` · `npx biome check <files>` · `npx vitest run`.
- `src/conversation` 전체를 한 번에 돌리면 병렬 부하로 서버 테스트 몇 개가 시간 초과로 떨어진다(2026-11-26: 9파일 · 17건) — 파일별로
  돌리면 전부 통과. 판정은 파일별 재실행으로 한다.
- 대시보드 클라이언트 테스트는 `renderDashboardPage` 템플릿을 잘라 `cook`한다: 페이지 마크업과 첫 `<style>` 안에 `${…}`를 넣으면
  수십 개 파일이 깨진다 — 마크업은 `dashboard.ts`에 그대로 쓰고 CSS는 자기 `<style id="…">` 블록에.
- `node:sqlite`는 Node 22.5부터 — CI(Node 20)에서는 SQLite 저장소 테스트만 건너뛴다.
- 세션 카드 본문은 `bodyMode: 'slot'` — 페이지가 그린다. `<ui-agent-inbox>`의 data `actions` · `primary`는 slot이 아닌 본문에만
  그려지므로 세션 카드에 버튼을 붙이려면 `renderCardBody`의 액션 바에 넣는다(#1450). 카드를 펼치는 `ui-toggle`은 `placeCard`로
  카드 데이터를 다시 만든다 — 데이터에 붙인 것은 펼치면 사라진다.
