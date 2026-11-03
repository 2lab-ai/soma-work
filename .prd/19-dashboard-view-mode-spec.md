# 19 — 대시보드 화면 모드: 미니멀 · 어드밴스드

Status: 구현 · Date: 2026-11-01
앞선 계약: [`14-dashboard-task-view-spec.md`](14-dashboard-task-view-spec.md) T1.6(자세히),
[`15-dashboard-detail-deck-spec.md`](15-dashboard-detail-deck-spec.md)(상세 카드)

> 이 문서가 대체하는 것: 14 T1.6의 패널 우상단 **자세히** 칩과 기기별 저장(`soma-panel-detail`).
>
> 이후: 각 모드가 무엇을 보여 줄지는 [`20-dashboard-view-plans-spec.md`](20-dashboard-view-plans-spec.md)의 1 · 2 · 3안이 정한다(기본 1안). 아래 T3 · T4의 미니멀 목록은 그 전의 상태이고, 지금은 20 §5.1의 1안이다.

## 0. 한 줄 정의

대시보드는 유저마다 화면이 둘이다. 기본은 **미니멀**이고, 상단바 오른쪽 끝 **어드밴스드**를 켜면 모든 정보가 나온다. 미니멀에서 상세 카드는 위쪽에 머리와 입력 필요만 두고, 나머지를 작업 목록과 채팅에 준다.

## 1. 요구 (SSOT 2026-11-01, 음성 메모 받아쓰기는 PR 본문에)

| id | 요구 | 구현 |
|---|---|---|
| T1 | 상세 카드의 디테일 옵션(자세히) 삭제 | `#panel-detail-toggle` · `togglePanelDetail` · `soma-panel-detail` 삭제. `.is-detail`은 어드밴스드가 켠다(`applyViewMode`) |
| T2 | 우상단 어드밴스드 온오프, 기본 꺼짐(미니멀), 유저마다 | `#view-mode-toggle`(app bar `slot="actions"`, `aria-pressed`). 설정 레지스트리 `dashboardMode`(그룹 `dashboard`, `minimal` · `advanced`), 저장소 `UserSettings.dashboardMode`. `PATCH /api/settings/dashboardMode`. 기기 사본 `soma-view-mode`는 첫 그림과 Slack 사용자가 없는 뷰어용 |
| T3 | 카드에는 가장 중요한 것만 | `minimalCard`: 제목 · 상태와 시간 · 진행 중 작업 · 요약(질문) · ★/CRON · 소유자. 펼친 카드(`renderCardBody(s, col, true)`): 액션(중지 · Slack) · 승인 · 질문 · 재개 · 결과 |
| T4 | 디테일을 눌러도 중요한 것만. 채팅과 작업 목록이 크게, 위 20%만 다른 것 | 미니멀 상세 카드: 부제 · 세션 정보 · goal · 산출물 · 에이전트 탭 · 섹션 탭 · 모델 숨김(모델은 T14 #805부터 다시 보임). 작업 목록 = 현재 목록 전체를 체크리스트로(`renderPanelTaskList`, 본문의 최대 34%, 넘치면 자기 상자에서 스크롤). 나머지는 채팅. 열면 언제나 메인 에이전트의 채팅 |
| T5 | 미니멀에서도 작업은 된다 | 승인 요청 · 질문 카드 · 입력칸 · 중지 · Slack은 숨기지 않는다 |
| T6 | 어드밴스드 = 지금 화면 | 페이지 전부(통계, 용량, CRON, 기본 모델 칩, 사용자 선택) + 예전 자세히 켬 |

## 1b. 두 번째 지시 (SSOT 2026-11-01, 원문)

> 미니멀 모드: 1. 최하단 우측에 토큰 가격, 모델 아이콘(클로드 오픈에이아이 그록 잼미니 기타) 모델 이름 그리고 한줄 추가해서 아티팩트 산출물 라인 추가해줘 2. 별표 토글 처리(태크스 카드시) 3. 에픽 일반 태스크 아이콘 표시
> 즐겨찾기 별 표시가 태스크 카드에서 그대로 토글 버튼으로 해줘

| id | 요구 | 구현 |
|---|---|---|
| T7 | 카드 맨 아래 오른쪽: 비용 · 모델 아이콘 · 모델 이름 | `minimalFootMetrics`: `$6.20`, `{ text: modelLabelOf, glyph: modelVendorOf }` — `@2lab.ai/ui` 0.16.0 vendor glyph `claude · openai · grok · gemini · model`. 카드 면의 모델 이름은 T11(#805)에서 아이콘으로 바뀜 |
| T8 | 산출물 줄 | 미니멀 카드에 `artifacts` · `artifactsCount` 유지(요소의 파일 칩 줄) |
| T9 | 별이 카드에서 그대로 토글 | 0.16.0 `card.star` → 카드 면 오른쪽 위 토글 버튼, `ui-star` → `doStar`(열린 카드의 ☆ 즐겨찾기와 같은 쓰기). 두 모드 모두. 소유자 외에는 상태만 보이고 눌리지 않음(이유 툴팁). 리드의 ★ 접두는 없앰 |
| T10 | 에픽 · 일반 태스크 아이콘 | 일반 작업: 체크 아이콘(0.16.0 glyph-only lead `task`), 에픽: `EPIC` + 레이어 아이콘(`epic`), 계획 노드 · 크론은 그대로 |

## 1c. 세 번째 지시 (SSOT 2026-11-02, 원문, [#805](https://github.com/2lab-ai/soma-work/issues/805))

> 작업 카드에 모델 표시가 지금 ai 제품 아이콘이랑 그 다음에 모델 이름이 나오는데 작업 카드에는 모델 제품 아이콘이랑 effort만 아이콘으로 표시해줘. (이건 리서치해서 svg로 그려서 추가) 그리고 모델별 색상 표시해줘. 이거 디테일 작업 카드에는 모델명 표시해야함 작업 카드에만 모델 아이콘으로 표시해서 미니멀하게 표현하려는 것

> (추가, 같은 날) 그리고 작업 카드에서 우하단에 나오는 모델 표시가 지금은 {아이콘} Opus 5.5 (1M) 이렇게 나오는데 이거 아이콘만 나오게해줘. (각각 AI 대표 색상으로 표시) (https://www.affectui.com/components/agent-findings 참조 모델 파비콘? 아이콘?) https://www.affectui.com/components/agent-fleet 이거도 참조해서 전반적으로 ui에서 모델 아이콘 사용해줘.

| id | 요구 | 구현 |
|---|---|---|
| T11 | 작업 카드 면: 모델은 제조사 마크 + effort 아이콘만, 이름 없음 | `faceFootMetrics` → `modelChipOf(model, effort)`: `{ text: '', glyph: modelVendorOf, effort, color, title, label }`. `@2lab.ai/ui` 0.22.0이 `text: ''`를 아이콘 전용 칩(`role="img"`)으로 그린다. effort는 5칸 막대 게이지 SVG(낮음 1 · 보통 2 · 높음 3 · 매우 높음 4 · 최대 5 · 울트라 5칸; 매우 높음 빨강, 최대 금박, 울트라 홀로그램 — 모델 메뉴의 effort 표현과 같음). 모르는 effort는 게이지 없이 마크만 |
| T12 | 모델별 색 → 각 AI의 대표색 (2026-11-02 추가 지시: "각각 AI 대표 색상으로 표시", affectui agent-findings · agent-fleet 참조) | `modelColorOf` = 회사 대표색 `MODEL_MAKER_COLOR`: Claude 모델 전부(Opus · Sonnet · Haiku · Fable) `#d97757`(클레이), Gemini `#4285f4`. OpenAI · Grok은 마크가 검정이라 색 없이 칩의 글자색을 쓴다. 모르는 모델도 색 없음. 라이브러리는 16진수 색만 받는다(`--ib-model-hue`, CSS 주입 차단). 처음에는 모델마다 색을 달리했다(Sonnet 보라, Haiku 청록 …). affectui는 같은 회사 모델에 같은 마크와 색을 쓴다 |
| T13 | 이름은 잃지 않는다 | 툴팁 `title`: `Opus 5.5 · 추론 강도 높음` + 줄바꿈 + 모델 ID. 화면 낭독기 `aria-label`: `모델 Opus 5.5, 추론 강도 높음`. 강제 색상 모드에서는 시스템 색으로 그린다. 게이지는 모델이 실제로 실행하는 단계를 그린다(`effortEffective`). 모델이 설정을 낮춰 실행하면 툴팁과 낭독기에 "추론 강도 높음 (설정 매우 높음)"처럼 둘 다 나온다(Grok은 매우 높음을 높음으로 실행). 보관된 카드는 그 세션의 effort가 남지 않아 게이지 없이 마크만 그린다(`effortFromDefault`, 리뷰 P1 · P2) |
| T14 | 디테일 카드는 모델 이름 그대로 | 상세 카드의 모델 · effort 줄(`#panel-controls`, `<ui-model-picker>` — 이름과 추론 강도)을 미니멀 기본안 1 · 2 · 3안 모두에서 켠다(`view-layout.ts` `DETAIL_LEAN` `controls: true`). 전에는 미니멀 상세 카드가 모델을 숨겼다(T4) — 면에서 이름이 빠지므로 이름이 남는 곳이 상세 카드다. 화면 편집기에서 직접 고친 상세 카드는 그 설정을 따른다. 편집기 미리보기는 샘플 effort `high`로 보드와 같은 칩을 그린다(`settings-layout-tab.ts` `LAY_EFFORT`) |
| T15 | UI 전반에 모델 아이콘 ([#813](https://github.com/2lab-ai/soma-work/issues/813), affectui agent-fleet 참조) | `@2lab.ai/ui` 0.23.0의 `core/model-mark` 하나가 모델의 회사, 마크, 대표색을 정한다. 모델 선택기(`<ui-model-picker>`: 펼친 카드, 디테일 카드 모델 줄, 새 작업, 상단 기본 모델)의 타일은 이름 첫 글자 대신 회사 마크다. 에이전트 트리(`<ui-agent-tree>`)는 `node.model`이 있으면 카드형에서는 아바타 자리에, 한 줄형에서는 이름 앞에 마크를 그린다. soma-work `atNode`는 메인에 세션 모델을, 서브에이전트에 `spend.model`(트랜스크립트에서 토큰을 가장 많이 쓴 모델, `agent-spend.ts`)을 넘긴다. 모르는 모델에는 마크를 그리지 않는다(추측하지 않음). 모든 호출의 사용량이 0으로 기록된 서브에이전트도 트랜스크립트가 모델을 적어 두므로 그 모델을 쓴다(llmux). 이 기능 전에 봉인된 비용은 `SPEND_CALC_VERSION` 4로 한 번 다시 읽어 모델을 얻는다. 보드 칩의 `modelVendorOf`는 라이브러리 `modelVendor`와 같은 규칙이며, 테스트가 둘을 묶어 둔다(#819 리뷰). 바꿀 수 없는 사람(소유자가 아닌 사람, 끝났거나 휴면이거나 다른 인스턴스에 있는 세션)도 같은 선택기를 비활성으로 본다. 회사 마크, 모델 이름, 단계가 나오고 메뉴는 열리지 않으며, 툴팁이 바꿀 수 없는 이유를 말한다(`data-mp-ro` → `data.disabled`, `mpReadOnlyWhy`). 예전에는 "opus-5-5[1m]" 같은 id 글자만 보였다(라이브 확인에서 찾음). 세션 패널의 에이전트 탭(`<ui-tabs>`, 0.24.0 `TabItem.model`)도 상태 점 뒤, 이름 앞에 회사 마크를 그린다(`panelTabsData`): 메인 탭은 세션 모델이고 보조 글자가 id 대신 모델 이름(`modelLabelOf`, "Opus 5.5 (1M)")이다. 서브에이전트 탭은 `spend.model`이고 보조 글자는 그대로 타입, 모델 이름은 툴팁에 있다. 마크는 읽히지 않는다(`aria-hidden`). 모델을 모르면 마크가 없다. 같은 0.24.0에서 비활성 선택기의 이름은 "— 바꾸기"를 뺀 "모델 X, 추론 강도 Y"다(ui#16) |

검증: `dashboard-view-plan-client.test.ts`(회사 대표색 표 · effort xhigh · 모르는 effort), `settings-layout-tab.test.ts`, `dashboard-view-mode-client.test.ts` T7. 실서버 하네스 `scripts/screenshot-layout-editor.ts` R4 · R10(칩에 글자 없음, `role=img`, 막대 3칸, `#d97757`, 상세 카드에 `Opus 5.5`), `scripts/screenshot-view-mode.ts` M4 · M7 · P4(상세 카드의 모델 줄).

## 2. 결정

- 저장은 기존 개인 설정 경로(`/api/settings`)를 쓴다. 인증 · CSRF · 관리자 승인 확인이 이미 있다. 이 설정만 Slack 명령이 없다(`slackCommand` 없음, 그룹 `dashboard`).
- `setUserDashboardMode`는 프롬프트 캐시를 버리지 않는다. 화면 모드는 어떤 프롬프트에도 들어가지 않는다.
- 미니멀은 숨김이지 삭제가 아니다. 데이터 경로와 폴링은 그대로다.
- 미니멀에서도 할 일은 손이 닿는다(리뷰 R1). 답을 기다리거나 실행 중인 크론 실행은 CRON 줄 대신 보드에 남는다(`planCronLane(…, liveOnBoard)`). 미니멀은 서브에이전트를 열지 않는다(`openPanel`은 메인 에이전트). All Users 화면(`/dashboard`)에서는 사용자 선택이 보인다 — 거기서는 자기를 골라야 소유자 조작이 열린다(`data-board-all`). 관리자 쓰기 모드 토글은 숨기지 않는다 — 관리자 승인에 답하려면 켜야 한다.
- 서버 응답 전에 누른 토글은 응답이 와도 되돌리지 않고 그때 저장한다. 저장 중에 온 설정 응답은 적용하지 않는다. 저장 실패는 알림으로 말한다.
- 20%는 고정 비율이 아니라 상한이다. 1280×860에서 위쪽은 804px 중 130px(16%), 390×844에서 844px 중 154px(18%)다. 변경 전 1280에서는 약 33%였고 채팅은 298px였다(지금 398px)(`scripts/screenshot-view-mode.ts`).

## 3. 검증

- 단위: `src/conversation/__tests__/dashboard-view-mode-client.test.ts`, `src/__tests__/user-settings-registry.test.ts`, `src/__tests__/user-settings-store.test.ts`.
- 브라우저: `scripts/screenshot-view-mode.ts` — 1280 라이트/다크, 390 라이트에서 87개 확인(T7~T10 포함: 비용·모델 표시, 산출물 줄, 별 토글이 카드를 열지 않고 별 쓰기를 보냄, 일반 작업·에픽 표시). 처음엔 69개 확인(기본 미니멀, 대기 크론 실행이 보드에 남음, 숨김, 카드 면, 상세 카드 20%, 질문 카드, 토글 저장과 새로고침 유지, 어드밴스드 복원, 가로 넘침 없음).
