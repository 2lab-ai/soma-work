# loop — 대시보드 × affectUI 레퍼런스 7종

Status: 출고(main `9de150c`) · dev 배포 완료(run 40389060249, t1·t2·t3) · 머지 증명 = [#437 코멘트](https://github.com/2lab-ai/soma-work/issues/437#issuecomment-6420008967) · 배포 후 QA = [#437 코멘트](https://github.com/2lab-ai/soma-work/issues/437#issuecomment-6429803246) · 에픽 #437 · PR #450–#456(스택) · 후속 #447 · #457 · 스펙 = [`../14-dashboard-affectui-spec.md`](../14-dashboard-affectui-spec.md) · SSOT = [`ssot.md`](ssot.md)

## 게이트 (build facts)
- 워크트리마다: `npx vitest run src/conversation/__tests__/` → `npx tsc --noEmit` → `npx biome check src/conversation/`.
- 머지 전 CI = `npm run check` · `npx tsc --noEmit` · `npm run test:release` · `npm run build` (`.github/workflows/ci.yml`).
- 화면 확인 = 로컬 미리보기(고정 데이터, `SOMA_CONFIG_DIR`을 임시 디렉터리로 격리 — 라이브 데이터에 닿지 않는다)로
  라이트·다크 × 데스크톱(1440)·폰(390) 캡처.
- 프리뷰 배포 = `main`을 `deploy/dev`로 머지하는 PR → `deploy.yml`.

## 서브이슈 · PR

| ssot-task | 서브이슈 | 레퍼런스 | 브랜치 | 문서 | PR | 상태 |
|---|---|---|---|---|---|---|
| T3.1 | #438 | Agent Inbox | `feat/dashboard-affectui-agent-inbox` | [`re-agent-inbox.md`](re-agent-inbox.md) | #450 | 머지 · R3 만장일치 |
| T3.2 | #439 | Agent Run | `feat/dashboard-affectui-agent-run` | [`re-agent-run.md`](re-agent-run.md) | #452 | 머지 · R3 만장일치 |
| T3.3 | #440 | AI Answer | `feat/dashboard-affectui-ai-answer` | [`re-ai-answer.md`](re-ai-answer.md) | #454 | 머지 · R2 만장일치 |
| T3.4 | #441 | Context Window | `feat/dashboard-affectui-context-window` | [`re-context-window.md`](re-context-window.md) | #451 | 머지 · R2 만장일치 |
| T3.5 | #442 | Model Picker | `feat/dashboard-affectui-model-picker` | [`re-model-picker.md`](re-model-picker.md) | #453 | 머지 · R2 만장일치 |
| T3.6 | #443 | Memory Panel | `feat/dashboard-affectui-memory-panel` | [`re-memory-panel.md`](re-memory-panel.md) | #456 | 머지 · R2 만장일치 |
| T3.7 | #444 | Agent Queue | `feat/dashboard-affectui-agent-queue` | [`re-agent-queue.md`](re-agent-queue.md) | #455 | 머지 · R5 만장일치 |

## 병합 순서
7개 브랜치가 같은 파일(`src/conversation/dashboard.ts`)의 서로 다른 구역을 고친다. 각 작업자는 자기 구역 옆에만 CSS·함수를
더한다. 머지는 한 번에 하나 — 머지 뒤 남은 브랜치는 `main` 위로 rebase하고 게이트를 다시 돈다.

순서(확정, 설계 리뷰 R1): **agent-inbox → context-window → agent-run → model-picker → ai-answer → agent-queue → memory-panel**.

실제 운영: **스택 PR**. CI 러너가 한 대(직렬)이고 `main` 보호가 strict가 아니라(최신화 불요), 각 PR 브랜치가 아래 층 PR 전부를
포함하게 쌓았다(#450 ← #451 ← … ← #456). 각 PR의 CI가 그 층까지 합친 트리를 시험하고, 아래 층이 머지 커밋으로 들어가면
위 층 PR은 충돌 없이 자기 커밋만 남는다. 층 사이 하네스 접착(서로의 함수 목록·고정 문자열)은 위 층 PR의 `test(dashboard): … glue`
커밋에 있다(#452·#453).

| 겹치는 자리 | 규칙 |
|---|---|
| `panelInfoHtml` 펼친 본문 | 순서 고정: `cw`(컨텍스트, #441) → `pi-details`(세부, #439) → `pi-grid`(누적 4행) → `pi-thread`. 각자 호출 한 줄 |
| 색 토큰 | 공유 `:root`(~3137)·light 블록(~3203)을 고치지 않는다. 각자 자기 CSS 구역에 별도 `:root{}` + `[data-theme="light"]{}` |
| reduced-motion · 터치 | 공유 `@media` 블록을 고치지 않는다. 각자 자기 구역에 별도 `@media` |
| Esc | 문서 핸들러(패널 닫기)보다 먼저 처리할 요소는 요소 단위 리스너 + `stopPropagation` (승인 카드 버튼, 모델 메뉴) |
| 카드 주 버튼 | 카드당 잉크 주 버튼 하나 — 권한 대기 카드는 카드 안 Approve(#438 소유) |

Memory Panel은 `settings-memory-tab.ts`만 고친다 — 열린 PR #380과 같은 파일이라, #380이 먼저 머지되면 그 위로 rebase한다.

## 설계 리뷰 (trinity)

| 라운드 | 패널 | 결과 | 차단 항목 → 반영 |
|---|---|---|---|
| R1 | grok · fable · astra | REJECT · REJECT · REJECT | `panelInfoHtml` 슬롯 충돌 → 순서 고정(위 표) · agent-run Esc 전파 → 요소 리스너 + stopPropagation · 권한 대기 카드의 주 버튼 0개 → #438이 카드 안 Approve를 주 버튼으로 · agent-queue escape 규칙 누락 → esc/escAttr/textContent + 시험 · agent-queue `binding` 오기 → 실제 조건으로 · (astra) 가용량 초↔크론 ms 단위 → 경계에서 ×1000 · 미기록 실행을 성공으로 집계 → 기록·진행·미확인 분리 · 승인 카드의 task 귀속(근거 없음) → 제거 · 답변 링크를 "출처"로 승격 → "답변에 포함된 링크" · 압축 완료를 카운터 증가로 판정 → 요청·관측·절약량 분리 |

## PR 코드 리뷰 (trinity, astra · grok · fable)

| PR | R1 | 차단 → 수정 | 이후 라운드 |
|---|---|---|---|
| #450 보드 | grok REJECT · fable APPROVE | 첫 낭독 유실, 카드 Approve 호버/잉크 둘 → b34b9f3 | R2 grok·fable APPROVE · astra REJECT(응답 가능한 Approve 둘이 모두 잉크, 형제 인스턴스 카드 잉크 둘) → b39ef87 → R3 만장일치 |
| #451 컨텍스트 | grok·fable APPROVE · astra REJECT | POST 결과 경쟁, `/new` 뒤 옛 압축 상태 → 2eaa434 | R2 만장일치 |
| #452 세션 패널 | grok REJECT · astra REJECT · fable APPROVE | 펼침 순서, 포커스된 Approve 재바인딩(오승인) → 5b34149 | R2 astra REJECT(질문 뜻 바뀌어도 버튼 재사용) → be279ec → R3 만장일치 |
| #453 모델 선택기 | 3 REJECT | Tab 이탈, fixed 조상 스크롤, 인덱스 선택 → d7aff1c·5ed00e5 | R2 만장일치 |
| #454 답변 카드 | grok·astra REJECT · fable APPROVE | 진행 중 fetch 경쟁, 코드 span 라벨 링크, 전송 실패 표시 → c2c0824 | R2 만장일치 |
| #455 가용량·크론 | grok REJECT · fable APPROVE | 성공 기록 진행 중 판정 → afa69fc | R2 fable REJECT(그 수정이 서버 실제 동작과 어긋남) → 8e4dd6c(스트립 규칙 복귀) → R3 grok·fable APPROVE · astra REJECT(익명 계정 이름 충돌로 다른 계정 카드가 열림) → cfd0c44 → R4 grok·fable APPROVE · astra REJECT(자리 키가 갱신을 건너 살아남음) → ed55ea5 → R5 만장일치 |
| #456 기억 탭 | grok REJECT · fable·astra APPROVE | 공백만 바꾼 편집 미저장, 길게 누른 Enter 연속 삭제 → 7b2ddf7·ef67f50 | R2 만장일치 |

비차단(P2/P3)은 #457에 모았다.

## 통합 화면 (7개 층을 모두 쌓은 꼭대기, 고정 데이터 미리보기)

| 화면 | 캡처 |
|---|---|
| 보드 — 펼친 카드(상태 태그·주 버튼 하나·모델 트리거) | [`after-desk-light-expanded.jpg`](assets/after-desk-light-expanded.jpg) |
| 세션 패널 — 계획 카드 · 컨텍스트 셀 필드 · 세부 · 가용량/크론 | [`after-desk-light-panel-info.jpg`](assets/after-desk-light-panel-info.jpg) · 다크 [`after-desk-dark-panel-info.jpg`](assets/after-desk-dark-panel-info.jpg) · 폰 [`after-phone-light-panel-info.jpg`](assets/after-phone-light-panel-info.jpg) |
| 모델 메뉴 — 막대·effort·가격 트레이 | [`after-desk-light-model-menu.jpg`](assets/after-desk-light-model-menu.jpg) |
| 답변 카드 — 링크 카드·칩·응답 시간 | [`after-desk-light-answer.jpg`](assets/after-desk-light-answer.jpg) |
| 설정 › 기억 — 칩·그룹·트레이 | [`after-desk-light-memory.jpg`](assets/after-desk-light-memory.jpg) |

## 사건 기록
- 2026-10-26 18:50 KST — 유저 지시 수신. 레퍼런스 7종 원천 수집(문서 청크·CSS·문구·캡처). 오픈소스 저장소에 7종 없음 확인(유료 항목).
- 2026-10-26 19:05 KST — 에픽 #437, 서브이슈 #438–#444 생성. 작업자 7명 Phase A(해부 문서) 착수.
- 2026-10-26 19:40–19:55 KST — 해부 문서 7개 완료(235–288줄). 작업자 7명 Phase B(구현) 착수.
- 2026-10-26 20:05 KST — 설계 리뷰 R1(grok·fable REJECT, 차단 5건) → 작업자에게 전달. 후속 이슈 #447(후속 지시 대기열 읽기 경로).
- 2026-10-26 21:00–23:30 KST — PR 코드 리뷰 R1–R3, 차단 항목 수정. 스택 통합 게이트(7층 꼭대기) 72 files · 1968/1968, tsc 0, biome 0.
- 2026-10-26 23:40 KST — 스택 푸시, PR #450–#456 열림(CI 대기열). 비차단 후속 #457.
- 2026-10-27 00:28 KST — #456 CI(상위 집합 head 8cbbe0d) scan · lean-verify 14m43s · quality-gates 12m21s 통과. icedac 승인 후 #456 머지 → main `9de150c`. 스택 아래 #450–#455 함께 MERGED, 서브이슈 #438–#444 자동 닫힘. 아래 층 PR의 중복 CI(24건)는 상위 집합 CI로 대체하고 취소했다.
- 2026-10-27 00:33 KST — 머지 기준 SSOT 증명(문서·PR·리뷰·CI)을 에픽 #437에 올렸다([코멘트](https://github.com/2lab-ai/soma-work/issues/437#issuecomment-6420008967)). dev 배포 PR #459(main → deploy/dev)
  머지, Deploy run 40350480733 시작 — 배포 결과는 아래 08:18 기록.
- 2026-10-27 01:17 KST — run 40350480733(#459): t1(work-m16)·t2(work-m64) 성공, t3(fable-m5max)는 러너 대기 중 취소.
  같은 concurrency 그룹(`deploy-deploy/dev`, cancel-in-progress)의 뒤 배포가 앞 run을 취소한다: #461(run 40360618036, `aadca4e7`)
  → #462(run 40367075865, `9e2aeb0`). 뒤 배포의 head는 모두 `9de150c`를 포함하므로 t3는 다음 run이 이어받는다.
  배포 전 기준선(dev, 실제 브라우저): 새 화면 요소 0 · 페이지 오류 0.
- 2026-10-27 08:18 KST — #462(run 40367075865)·#469(run 40387536952, `636a24fc`)도 뒤 배포가 취소. #470 run 40389060249
  (deploy/dev `8f688f5d` ⊇ `9de150c`)에서 t1·t2·t3 모두 성공(t3 23:18:33Z). 배포 후 QA(실제 브라우저, 라이트·다크): 7개 화면 요소 0 → 있음, 페이지 오류 0, 모델 메뉴
  열림·Esc 닫힘·포커스 복귀, 카드 30장 중 28장 `effortLevels`. 컨텍스트 셀 필드는 재시작 뒤 첫 턴이 끝나야 데이터가 생긴다
  (`usage.contextWindow`는 턴 종료 result에서 채워진다). 기록 = [#437 배포 후 QA 코멘트](https://github.com/2lab-ai/soma-work/issues/437#issuecomment-6429803246).
