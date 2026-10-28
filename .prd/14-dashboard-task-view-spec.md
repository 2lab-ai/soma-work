# 14 — 대시보드 태스크 뷰: 공통 서피스 · 에이전트 탭 · Tasks의 결말

Status: 구현 · Date: 2026-10-27 · 기준 main `8332695b`
앞선 계약: [`13-dashboard-three-surfaces-spec.md`](13-dashboard-three-surfaces-spec.md) §3(패널),
[`11-dashboard-live-surfaces-spec.md`](11-dashboard-live-surfaces-spec.md) T7/T8(task ledger),
[`12-dashboard-agent-tree-spec.md`](12-dashboard-agent-tree-spec.md) §4.3(패널의 에이전트)

> 이 문서가 대체하는 것: 13 §3의 "Tasks·Artifacts 고정 + 스크롤 영역이 본문의 절반 이상" 배치, 답변의 "요약이 얼굴, 답변 전문은 펼쳐야"(re-ai-answer D1), 11 T7의 "목록 밖으로 밀려난 **완료** task"라는 서술(실제로는 미완료 task도 밀려났고, 그 상태가 그대로 남았다).

## 0. 한 줄 정의

세션 패널은 태스크 뷰다. 위는 태스크 공통 서피스(세션 정보 · 입력 필요 · 산출물), 그 아래는 에이전트 탭(Main은 항상 맨 왼쪽)이고, 탭마다 Tasks(접힘) · 작업 로그(접힘) · 지시와 답변(펼침)이 있다. 기본은 꼭 필요한 정보만 보이고(패널은 맨 위에서 열리고 지시와 답변은 최신 대화), 우상단 **자세히** 토글 버튼을 켜면 모든 섹션이 펼쳐진다. Tasks는 새 계획으로 빠진 task를 진행 중이나 대기로 보이지 않게, 완료 · 중단 · 실행 안 됨으로 나눠 보여 준다.

## 1. 요구 (SSOT 2026-10-27, 원문 요약은 PR 본문에)

| id | 요구 | 구현 |
|---|---|---|
| T1.1 | 상단 공통 정보 서피스: 세션 정보 · 입력 필요 · 산출물 | `#panel-surface` — `#panel-info` · `#panel-goal` · 입력 필요(`#panel-needs-head` · `#panel-permission` · `#panel-question`) · `#panel-artifacts` |
| T1.2 | 하단 에이전트 탭, Main은 왼쪽에 항상 | `#panel-tabs` role=tablist: `panelTabsHtml` — Main 다음 서브에이전트를 spawn 순서로. 스크롤 영역 위에 sticky, Main 탭은 가로 스크롤에서도 왼쪽에 sticky. ←/→/Home/End로 이동하면 바로 선택된다(WAI-ARIA tabs, automatic activation) |
| T1.3 | 탭마다 태스크 리스트(접힘) · 작업 로그(접힘) · 지시와 답변(펼침) | `#panel-tabpanel`: `#panel-tasks`(`_panelTasksOpen` 기본 false, 접힌 머리 한 줄 = 진행 중 단계 · 완료/전체 · 새 계획으로 빠진 수) · `#panel-worklog`(기본 접힘) · `#panel-conv`(기본 펼침). 기본(최소)에서 지시와 답변은 **최신 대화 한 묶음**(마지막 지시와 그 뒤)이고, 그 앞의 대화는 `이전 대화 n개`(`#conv-earlier`, `showEarlierTurns`) 뒤에 접힌다 — CSS `:has(~ .turn.user)`. 자세히는 모든 대화. 서브에이전트 탭의 지시와 답변 = 작업 로그의 시작 호출(입력 JSON의 `prompt`)과 결과(`renderAgentConv`) |
| T1.4 | AI 답변은 기본이 답변 전문, 맨 아래에 raw | 어시스턴트 턴 = `.turn-answer`(화면 근처에 오면 불러오는 렌더된 답변, `IntersectionObserver` rootMargin 800px) → 턴 산출물 → `<details class="turn-raw">Raw</details>`(요약 + 원문 마크다운). 답변을 못 읽으면(기록 없음 · 권한 없음) 요약이 얼굴이 된다 |
| T1.5 | 세션 모델 + 그 아래 스티어링 입력: 여러 줄 · 이미지 · 파일 · 음성 | `#panel-controls`(모델 · effort) 아래 `<textarea id="cmd-input">`: Enter 보내기, Shift+Enter 줄바꿈, IME 조합 중(한글) Enter는 보내지 않음, 폰에서는 Enter가 줄바꿈. 이미지 붙여넣기 · 끌어놓기 · 선택, 파일 첨부, 음성 녹음(MediaRecorder). 서버: `POST /api/dashboard/session/:key/command { message, attachments? }`(새 작업과 같은 제한 · body limit, 파일만 보내기 허용) → `injectDashboardMessage`가 세션 스레드에 업로드(`uploadFiles`)하고 `event.files`로 넘긴다 |
| T1.6 | 기본은 중요한 정보만, 우상단 자세히 토글로 전부 | `#panel-detail-toggle` — 스위치가 아니라 **토글처럼 동작하는 버튼**(HIG Toggles, §5), 켜지면 배경이 채워진다. 기기별 저장 `soma-panel-detail`. 꺼짐: 패널이 **맨 위에서 열린다**(서피스 → 탭 → 최신 대화가 한 화면) · 세션 정보 한 줄 · 빈 goal 편집기 숨김 · 산출물은 이름 칩 한 줄 · 에이전트 경로 · 하위 트리 · 메인 머리 숨김 · Tasks/작업 로그 접힘 · 최신 대화만. 켜짐: 모든 섹션 펼침(세션 정보 전체, 산출물 썸네일, Tasks 전체 단계와 이전 계획, 작업 로그, 에이전트 경로와 하위 트리, 모든 대화)이고 최신 턴에 착지한다 |
| T2 | Tasks: 새 task 목록이 기존 목록을 지울 때, 실행 안 되고 사라진 task를 구분하고 "진행 중" 오표시를 없앤다 | §3 |

## 2. 배치 (Apple식 기본 최소)

```
패널 머리   제목 · 부제                         [≡ 자세히] [×]
            세션 칩(상태 · 시간)            Slack  Stop
스크롤 ─┬─ 공통 서피스   세션 정보(한 줄 + 링크) · goal · 입력 필요 · 산출물(이름 칩)
        ├─ 에이전트 탭   [Main opus] [A1 Explore] [A2 librarian] …   ← sticky
        └─ 탭 패널       (자세히: 에이전트 머리 · 경로 · 하위 트리)
                         Tasks ▸ 화면 수정 중 · 1/3 · 이전 계획 중단 1 · 실행 안 됨 2
                         작업 로그 ▸ 3
                         지시와 답변 ▾  (이전 대화 n개) 최신 지시 → 답변(렌더) → ▸Raw
입력        모델 · effort
            [📎][🖼][🎤]  여러 줄 입력…                       [Send]
```

폰(640px 미만 또는 높이 560px 미만)에서도 세션 모델이 입력칸 위에 있다: 첫 줄에 모델 · effort와 도구(📎 🖼 🎤), 그 아래 줄에 입력칸과 Send.

낮은 화면(높이 560px 이하 — 가로로 든 폰, 펼친 Duo): 도킹 패널(폭 840px 이상)이 두 줄로 접힌 상단바 아래가 아니라 화면 전체 높이를 쓴다(상단바 오른쪽 끝 위, 기본 모델 칩은 패널을 닫으면 다시 보인다). 부제목 줄은 자세히일 때만 보인다. 읽기 영역(실측, 패널 열림): 956×440 199px(main 33px), 844×390 149px(main 0px).

착지: 기본(최소) 열기는 맨 위(`scrollTop 0`)에 한 번 착지하고, 턴이 도착해 다시 불려도 읽는 사람이 스크롤했으면 그대로 둔다(`_panelLandAt`). 질문 · 승인 요청이 있으면 그 카드, 관리 → · 상세 · 전체 task는 그 섹션, 자세히 켜짐은 최신 턴. 섹션 착지가 아직 짧은 본문 때문에 덜 됐으면 본문이 자랄 때(답변이 늦게 로드) 다시 착지한다(`ResizeObserver`).

## 3. Tasks의 결말 (T2)

### 3.1 원인 — TodoWrite는 목록을 통째로 바꾼다

Claude의 TodoWrite는 매 호출마다 목록 전체를 보낸다. 새 목록에 없는 항목은 그 시점에 계획에서 빠진 것이다. ledger(`src/session/task-ledger.ts`)는 직전 목록에서 같은 문구인 항목만 같은 task로 보고, 나머지를 `earlier`로 넘긴다. 그런데 넘길 때 상태를 닫지 않았다.

- 진행 중에 빠진 task는 `in_progress`와 `startedAt`이 그대로 남았다. 패널의 이전 task, 작업 로그 그룹 머리, 서브에이전트, 보관 세션 모두가 스피너와 끝없이 흐르는 시계로 "진행 중"을 그렸다.
- 시작 전에 빠진 task는 `pending`으로 남아 실제 대기 task와 똑같이 보였다. 카드의 "전체 task N개"도 이를 셌다.
- `/new` · renew · 핸드오프(`closeTaskList`)도 목록 전체를 같은 방식으로 넘겼다.
- `normalizeTaskProgress`는 현재 목록에만 적용됐고, 모든 `earlier` 경로(보드 · WebSocket · 보관 · 서브에이전트)는 정규화되지 않았다.

### 3.2 기록 — ledger

- `TaskRecord.removedAt`: 목록에서 빠진 시각. `applyTodoList`(직전 목록의 항목 중 새 목록이 갖지 않은 것)와 `closeTaskList(ledger, now)`가 한 번만 찍는다. `sanitizeTaskLedger`가 복원한다.
- `ledgerTasks().earlier`의 미완료 항목에 `dropped`: `started`(진행 중이었거나 시작 시각이 있음 → 중단), `unstarted`(한 번도 시작 안 함 → 실행 안 됨). 기록에서 유도하므로 이 필드 전에 저장된 ledger도 같은 판정을 받는다(시각만 없다).
- 상태 union(`pending | in_progress | completed`)은 그대로다. 새 arm을 더하지 않고 view 필드로 표현해, 상태를 읽는 다른 소비자(Slack 블록, 카드 face)가 깨지지 않는다.

### 3.3 표시 — 결말 여섯 가지

| 결말 | 조건 | 표시 |
|---|---|---|
| 완료 | `completed` | ✓, 소요 시간 |
| 진행 중 | `in_progress`이고 세션(또는 에이전트)이 지금 돈다 | 스피너, 1Hz 시계 — 유일하게 움직이는 표시 |
| 멈춤 | 현재 목록, 시작했지만 세션이 멈춤(서버가 pending으로 내리되 `startedAt` 유지) | ⏸, "멈춤" |
| 대기 | 현재 목록, 아직 시작 안 함 | 빈 원 |
| 중단 | 새 계획이 진행 후에 뺌(`dropped: started`) | ⊘, "중단", 시작부터 빠질 때까지의 시간 |
| 실행 안 됨 | 새 계획이 시작 전에 뺌(`dropped: unstarted`) | –, 취소선, "실행 안 됨" |

- 이전 계획은 접힌 토글 하나(`이전 계획 완료 n · 중단 n · 실행 안 됨 n`)다. 열면 교체 시점별 묶음(`HH:MM 새 계획으로 교체`, 시각이 없는 옛 기록은 `이전 기록`)이 나온다.
- 접힌 Tasks 머리가 빠진 수를 말한다: `… · 이전 계획 중단 1 · 실행 안 됨 2`.
- 카드의 `전체 task N개`는 실행 안 됨을 세지 않는다.
- 작업 로그 그룹 머리(`renderTaskMeta`)도 빠진 task에 시계를 달지 않는다.
- 서브에이전트 탭도 자기 이전 계획을 보여 준다(`panelAgentEarlier`).

### 3.4 남는 한계

동일성은 "직전 목록에서 같은 문구"다. 모델이 문구를 고쳐 다시 보낸 같은 일은 옛 문구가 `실행 안 됨`, 새 문구가 새 task로 남는다. 문구 유사도로 추측하지 않는다. 표시는 사실("시작 전에 계획에서 빠짐")만 말한다.

## 4. 검증 (갱신 2026-10-27 delta)

- 단위: `src/session/__tests__/task-ledger-dropped.test.ts`(ledger), `src/conversation/__tests__/dashboard-task-view-client.test.ts`(결말 · 이전 계획 · 탭 · 답변 순서 · 입력 · 자세히), `src/conversation/__tests__/dashboard-command-attachments.test.ts`(명령 경로 첨부).
- 브라우저: `scripts/screenshot-task-view.ts` — 1280 라이트/다크, 390 라이트(시나리오당 42개 확인)에서 배치 순서, 서피스 세 부분이 각각 그려짐(세션 정보 · 산출물 · 기다리는 세션의 입력 필요 = 질문 카드와 승인 요청), 맨 위 착지와 최신 대화 · 이전 대화, 기본 접힘, 렌더된 답변과 Raw, 탭 범위, 키보드, 이전 계획, 자세히 켜기/끄기, 여러 줄 · 붙여넣은 이미지 · 📎로 고른 파일 · Chromium 가짜 마이크로 실제 녹음한 음성(단독 전송, 녹음 중 전송), 가로 넘침 없음. 전송은 브라우저 본문 그대로 **실제 명령 라우트**(검증 · body limit · 소유자 확인)로 가고, 핸들러는 운영 업로드 경로(`createSlackSteerUploader`, Slack 더블)로 올린다.
- Slack 업로드 구간: `src/conversation/__tests__/new-task-provider.steer.test.ts` — 파일마다 한 번 업로드, 파이프라인 `event.files` 모양, 메타데이터 읽기 실패 후 재시도는 다시 올리지 않음, Slack 밖 URL 거부.

## 5. Apple HIG 리서치 — 결정과 원칙

출처: Apple Human Interface Guidelines, 2026-10-27에 `developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`에서 받은 원문. 인용은 원문 그대로다.

| 결정 | HIG 원문 | 페이지 |
|---|---|---|
| 맨 위에서 연다: 상태 칩 → 세션 정보 → 입력 필요 → 산출물 → 탭 → 최신 대화 | "Order content by relative importance. … place the most important items near the top and leading side of the window or display." | [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) |
| 기본 최소: Tasks · 작업 로그 접힘, 세션 정보 한 줄, 이전 대화 접힘, 자세히로 전부 | "Use progressive disclosure to make layouts cleaner and easier to interact with. … Use disclosure triangles, menus, or nested views to reduce how much content to initially display" | [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) |
| 자주 보는 것은 늘 보이고, 깊은 정보는 기본으로 숨김 | "Use a disclosure control to hide details until they’re relevant. Place controls that people are most likely to use at the top of the disclosure hierarchy so they’re always visible, with more advanced functionality hidden by default." | [Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls) |
| 접힌 섹션 머리가 무엇이 숨었는지 말한다(`Tasks · 화면 수정 중 · 1/3 · 이전 계획 중단 1`) | "Provide a descriptive label when using a disclosure triangle. Make sure your labels indicate what is disclosed or hidden" | [Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls) |
| 탭은 에이전트별 같은 구성(Tasks · 로그 · 지시와 답변), 태스크 공통 정보는 탭 밖 서피스 | "Use a tab view to present closely related areas of content." · "Make sure the controls within a pane affect content only in the same pane." | [Tab views](https://developer.apple.com/design/human-interface-guidelines/tab-views) |
| 탭 이름 = 에이전트 이름 · 종류 · 상태 | "Provide a label for each tab that describes the contents of its pane." | [Tab views](https://developer.apple.com/design/human-interface-guidelines/tab-views) |
| 탭 줄은 스크롤해도 위에 붙어 있다(sticky), Main은 왼쪽 고정 | "Make sure the tab bar is visible when people navigate to different sections of your app." | [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) |
| 섹션은 여백 · 구분선으로 묶는다(서피스 / 탭 / 탭 패널) | "Group related items to clearly express related information or functions. For example, you might use negative space, container shapes, or separator lines" | [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) |
| 자세히는 스위치가 아니라 토글처럼 동작하는 버튼, 켜지면 배경이 채워진다 | "Outside of a list, use a button that behaves like a toggle, not a switch." · "you update its appearance — typically by changing the background — based on the current state." · (macOS) "avoid using these components in a toolbar or status bar." | [Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles) |
| 켜짐과 꺼짐은 채움의 유무로 구분(색만으로 구분하지 않음), `aria-pressed` | "Make sure the visual differences in a toggle’s state are obvious. … Avoid relying solely on different colors to communicate state" | [Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles) |
| 입력은 여러 줄 텍스트 뷰(자동 높이, Shift+Enter 줄바꿈) | "Use a text view when you need to display text that’s long, editable, or in a special format." | [Text views](https://developer.apple.com/design/human-interface-guidelines/text-views) |

원칙에서 벗어난 것(의도적):

- **탭 수.** HIG Tab views는 "Avoid providing more than six tabs in a tab view."라고 한다. 서브에이전트 수는 세션이 정하므로 상한을 둘 수 없다. 탭 줄은 가로로 스크롤되고 Main은 왼쪽에 붙어 있으며, 전체 그림은 자세히의 에이전트 트리가 맡는다.
- **탭 줄 위치.** HIG Tab views는 탭 컨트롤을 콘텐츠 위쪽 가장자리에 둔다. 여기서는 태스크 공통 서피스가 탭 위에 있다(유저 요구 T1.1). 탭 줄은 스크롤하면 위에 붙어 그 자리를 지킨다.

