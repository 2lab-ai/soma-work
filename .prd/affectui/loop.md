# loop — 대시보드 × affectUI 레퍼런스 7종

Status: 진행 · 에픽 #437 · 스펙 = [`../14-dashboard-affectui-spec.md`](../14-dashboard-affectui-spec.md) · SSOT = [`ssot.md`](ssot.md)

## 게이트 (build facts)
- 워크트리마다: `npx vitest run src/conversation/__tests__/` → `npx tsc --noEmit` → `npx biome check src/conversation/`.
- 머지 전 CI = `npm run check` · `npx tsc --noEmit` · `npm run test:release` · `npm run build` (`.github/workflows/ci.yml`).
- 화면 확인 = 로컬 미리보기(고정 데이터, `SOMA_CONFIG_DIR`을 임시 디렉터리로 격리 — 라이브 데이터에 닿지 않는다)로
  라이트·다크 × 데스크톱(1440)·폰(390) 캡처.
- 프리뷰 배포 = `main`을 `deploy/dev`로 머지하는 PR → `deploy.yml`.

## 서브이슈 · PR

| ssot-task | 서브이슈 | 레퍼런스 | 브랜치 | 문서 | PR | 상태 |
|---|---|---|---|---|---|---|
| T3.1 | #438 | Agent Inbox | `feat/dashboard-affectui-agent-inbox` | [`re-agent-inbox.md`](re-agent-inbox.md) | — | 문서 |
| T3.2 | #439 | Agent Run | `feat/dashboard-affectui-agent-run` | [`re-agent-run.md`](re-agent-run.md) | — | 문서 |
| T3.3 | #440 | AI Answer | `feat/dashboard-affectui-ai-answer` | [`re-ai-answer.md`](re-ai-answer.md) | — | 문서 |
| T3.4 | #441 | Context Window | `feat/dashboard-affectui-context-window` | [`re-context-window.md`](re-context-window.md) | — | 문서 |
| T3.5 | #442 | Model Picker | `feat/dashboard-affectui-model-picker` | [`re-model-picker.md`](re-model-picker.md) | — | 문서 |
| T3.6 | #443 | Memory Panel | `feat/dashboard-affectui-memory-panel` | [`re-memory-panel.md`](re-memory-panel.md) | — | 문서 |
| T3.7 | #444 | Agent Queue | `feat/dashboard-affectui-agent-queue` | [`re-agent-queue.md`](re-agent-queue.md) | — | 문서 |

## 병합 순서
7개 브랜치가 같은 파일(`src/conversation/dashboard.ts`)의 서로 다른 구역을 고친다. 각 작업자는 자기 구역 옆에만 CSS·함수를
더한다. 머지는 한 번에 하나 — 머지 뒤 남은 브랜치는 `main` 위로 rebase하고 게이트를 다시 돈다.
Memory Panel은 `settings-memory-tab.ts`만 고친다 — 열린 PR #380과 같은 파일이라, #380이 먼저 머지되면 그 위로 rebase한다.

## 사건 기록
- 2026-10-26 18:50 KST — 유저 지시 수신. 레퍼런스 7종 원천 수집(문서 청크·CSS·문구·캡처). 오픈소스 저장소에 7종 없음 확인(유료 항목).
- 2026-10-26 19:05 KST — 에픽 #437, 서브이슈 #438–#444 생성. 작업자 7명 Phase A(해부 문서) 착수.
