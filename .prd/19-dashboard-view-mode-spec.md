# 19 — 대시보드 화면 모드: 미니멀 · 어드밴스드

Status: 구현 · Date: 2026-11-01
앞선 계약: [`14-dashboard-task-view-spec.md`](14-dashboard-task-view-spec.md) T1.6(자세히),
[`15-dashboard-detail-deck-spec.md`](15-dashboard-detail-deck-spec.md)(상세 카드)

> 이 문서가 대체하는 것: 14 T1.6의 패널 우상단 **자세히** 칩과 기기별 저장(`soma-panel-detail`).

## 0. 한 줄 정의

대시보드는 유저마다 화면이 둘이다. 기본은 **미니멀**이고, 상단바 오른쪽 끝 **어드밴스드**를 켜면 모든 정보가 나온다. 미니멀에서 상세 카드는 위쪽에 머리와 입력 필요만 두고, 나머지를 작업 목록과 채팅에 준다.

## 1. 요구 (SSOT 2026-11-01, 음성 메모 받아쓰기는 PR 본문에)

| id | 요구 | 구현 |
|---|---|---|
| T1 | 상세 카드의 디테일 옵션(자세히) 삭제 | `#panel-detail-toggle` · `togglePanelDetail` · `soma-panel-detail` 삭제. `.is-detail`은 어드밴스드가 켠다(`applyViewMode`) |
| T2 | 우상단 어드밴스드 온오프, 기본 꺼짐(미니멀), 유저마다 | `#view-mode-toggle`(app bar `slot="actions"`, `aria-pressed`). 설정 레지스트리 `dashboardMode`(그룹 `dashboard`, `minimal` · `advanced`), 저장소 `UserSettings.dashboardMode`. `PATCH /api/settings/dashboardMode`. 기기 사본 `soma-view-mode`는 첫 그림과 Slack 사용자가 없는 뷰어용 |
| T3 | 카드에는 가장 중요한 것만 | `minimalCard`: 제목 · 상태와 시간 · 진행 중 작업 · 요약(질문) · ★/CRON · 소유자. 펼친 카드(`renderCardBody(s, col, true)`): 액션(중지 · Slack) · 승인 · 질문 · 재개 · 결과 |
| T4 | 디테일을 눌러도 중요한 것만. 채팅과 작업 목록이 크게, 위 20%만 다른 것 | 미니멀 상세 카드: 부제 · 세션 정보 · goal · 산출물 · 에이전트 탭 · 섹션 탭 · 모델 숨김. 작업 목록 = 현재 목록 전체를 체크리스트로(`renderPanelTaskList`, 본문의 최대 34%, 넘치면 자기 상자에서 스크롤). 나머지는 채팅. 열면 언제나 메인 에이전트의 채팅 |
| T5 | 미니멀에서도 작업은 된다 | 승인 요청 · 질문 카드 · 입력칸 · 중지 · Slack은 숨기지 않는다 |
| T6 | 어드밴스드 = 지금 화면 | 페이지 전부(통계, 용량, CRON, 기본 모델 칩, 사용자 선택) + 예전 자세히 켬 |

## 2. 결정

- 저장은 기존 개인 설정 경로(`/api/settings`)를 쓴다. 인증 · CSRF · 관리자 승인 확인이 이미 있다. 이 설정만 Slack 명령이 없다(`slackCommand` 없음, 그룹 `dashboard`).
- `setUserDashboardMode`는 프롬프트 캐시를 버리지 않는다. 화면 모드는 어떤 프롬프트에도 들어가지 않는다.
- 미니멀은 숨김이지 삭제가 아니다. 데이터 경로와 폴링은 그대로다.
- 미니멀에서도 할 일은 손이 닿는다(리뷰 R1). 답을 기다리거나 실행 중인 크론 실행은 CRON 줄 대신 보드에 남는다(`planCronLane(…, liveOnBoard)`). 미니멀은 서브에이전트를 열지 않는다(`openPanel`은 메인 에이전트). All Users 화면(`/dashboard`)에서는 사용자 선택이 보인다 — 거기서는 자기를 골라야 소유자 조작이 열린다(`data-board-all`). 관리자 쓰기 모드 토글은 숨기지 않는다 — 관리자 승인에 답하려면 켜야 한다.
- 서버 응답 전에 누른 토글은 응답이 와도 되돌리지 않고 그때 저장한다. 저장 중에 온 설정 응답은 적용하지 않는다. 저장 실패는 알림으로 말한다.
- 20%는 고정 비율이 아니라 상한이다. 1280×860에서 위쪽은 804px 중 130px(16%), 390×844에서 844px 중 154px(18%)다. 변경 전 1280에서는 약 33%였고 채팅은 298px였다(지금 398px)(`scripts/screenshot-view-mode.ts`).

## 3. 검증

- 단위: `src/conversation/__tests__/dashboard-view-mode-client.test.ts`, `src/__tests__/user-settings-registry.test.ts`, `src/__tests__/user-settings-store.test.ts`.
- 브라우저: `scripts/screenshot-view-mode.ts` — 1280 라이트/다크, 390 라이트에서 69개 확인(기본 미니멀, 대기 크론 실행이 보드에 남음, 숨김, 카드 면, 상세 카드 20%, 질문 카드, 토글 저장과 새로고침 유지, 어드밴스드 복원, 가로 넘침 없음).
