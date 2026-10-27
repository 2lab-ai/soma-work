# 14 — 대시보드 태스크 뷰: 공통 서피스 · 에이전트 탭 · Tasks의 결말

Status: 구현 · Date: 2026-10-27 · 기준 main `8332695b`
앞선 계약: [`13-dashboard-three-surfaces-spec.md`](13-dashboard-three-surfaces-spec.md) §3(패널),
[`11-dashboard-live-surfaces-spec.md`](11-dashboard-live-surfaces-spec.md) T7/T8(task ledger),
[`12-dashboard-agent-tree-spec.md`](12-dashboard-agent-tree-spec.md) §4.3(패널의 에이전트)

> 이 문서가 대체하는 것: 13 §3의 "Tasks·Artifacts 고정 + 스크롤 영역이 본문의 절반 이상" 배치, 답변의 "요약이 얼굴, 답변 전문은 펼쳐야"(re-ai-answer D1), 11 T7의 "목록 밖으로 밀려난 **완료** task"라는 서술(실제로는 미완료 task도 밀려났고, 그 상태가 그대로 남았다).

## 0. 한 줄 정의

세션 패널은 태스크 뷰다. 위는 태스크 공통 서피스(세션 정보 · 입력 필요 · 산출물), 그 아래는 에이전트 탭(Main은 항상 맨 왼쪽)이고, 탭마다 Tasks(접힘) · 작업 로그(접힘) · 지시와 답변(펼침)이 있다. 기본은 꼭 필요한 정보만 보이고, 우상단 **자세히** 스위치를 켜면 모든 섹션이 펼쳐진다. Tasks는 새 계획으로 빠진 task를 진행 중이나 대기로 보이지 않게, 완료 · 중단 · 실행 안 됨으로 나눠 보여 준다.

## 1. 요구 (SSOT 2026-10-27, 원문 요약은 PR 본문에)

| id | 요구 | 구현 |
|---|---|---|
| T1.1 | 상단 공통 정보 서피스: 세션 정보 · 입력 필요 · 산출물 | `#panel-surface` — `#panel-info` · `#panel-goal` · 입력 필요(`#panel-needs-head` · `#panel-permission` · `#panel-question`) · `#panel-artifacts` |
| T1.2 | 하단 에이전트 탭, Main은 왼쪽에 항상 | `#panel-tabs` role=tablist: `panelTabsHtml` — Main 다음 서브에이전트를 spawn 순서로. 스크롤 영역 위에 sticky, Main 탭은 가로 스크롤에서도 왼쪽에 sticky. ←/→/Home/End로 이동하면 바로 선택된다(WAI-ARIA tabs, automatic activation) |
| T1.3 | 탭마다 태스크 리스트(접힘) · 작업 로그(접힘) · 지시와 답변(펼침) | `#panel-tabpanel`: `#panel-tasks`(`_panelTasksOpen` 기본 false, 접힌 머리 한 줄 = 진행 중 단계 · 완료/전체 · 새 계획으로 빠진 수) · `#panel-worklog`(기본 접힘) · `#panel-conv`(기본 펼침). 서브에이전트 탭의 지시와 답변 = 작업 로그의 시작 호출(입력 JSON의 `prompt`)과 결과(`renderAgentConv`) |
| T1.4 | AI 답변은 기본이 답변 전문, 맨 아래에 raw | 어시스턴트 턴 = `.turn-answer`(화면 근처에 오면 불러오는 렌더된 답변, `IntersectionObserver` rootMargin 800px) → 턴 산출물 → `<details class="turn-raw">Raw</details>`(요약 + 원문 마크다운). 답변을 못 읽으면(기록 없음 · 권한 없음) 요약이 얼굴이 된다 |
| T1.5 | 세션 모델 + 그 아래 스티어링 입력: 여러 줄 · 이미지 · 파일 · 음성 | `#panel-controls`(모델 · effort) 아래 `<textarea id="cmd-input">`: Enter 보내기, Shift+Enter 줄바꿈, IME 조합 중(한글) Enter는 보내지 않음, 폰에서는 Enter가 줄바꿈. 이미지 붙여넣기 · 끌어놓기 · 선택, 파일 첨부, 음성 녹음(MediaRecorder). 서버: `POST /api/dashboard/session/:key/command { message, attachments? }`(새 작업과 같은 제한 · body limit, 파일만 보내기 허용) → `injectDashboardMessage`가 세션 스레드에 업로드(`uploadFiles`)하고 `event.files`로 넘긴다 |
| T1.6 | 기본은 중요한 정보만, 우상단 자세히 토글로 전부 | `#panel-detail-toggle`(기기별 저장 `soma-panel-detail`). 꺼짐: 세션 정보 한 줄 · 빈 goal 편집기 숨김 · 에이전트 경로 · 하위 트리 · 메인 머리 숨김 · Tasks/작업 로그 접힘. 켜짐: 모든 섹션 펼침(세션 정보 전체, Tasks 전체 단계와 이전 계획, 작업 로그, 에이전트 경로와 하위 트리) |
| T2 | Tasks: 새 task 목록이 기존 목록을 지울 때, 실행 안 되고 사라진 task를 구분하고 "진행 중" 오표시를 없앤다 | §3 |

## 2. 배치 (Apple식 기본 최소)

```
패널 머리   제목 · 부제                         [자세히 ◯] [×]
            세션 칩(상태 · 시간)            Slack  Stop
스크롤 ─┬─ 공통 서피스   세션 정보(한 줄 + 링크) · goal · 입력 필요 · 산출물
        ├─ 에이전트 탭   [Main opus] [A1 Explore] [A2 librarian] …   ← sticky
        └─ 탭 패널       (자세히: 에이전트 머리 · 경로 · 하위 트리)
                         Tasks ▸ 화면 수정 중 · 1/3 · 이전 계획 중단 1 · 실행 안 됨 2
                         작업 로그 ▸ 3
                         지시와 답변 ▾  지시 → 답변(렌더) → ▸Raw
입력        모델 · effort
            [📎][🖼][🎤]  여러 줄 입력…                       [Send]
```

폰(640px 미만 또는 높이 560px 미만): 입력칸이 한 줄을 다 쓰고, 모델 · effort · 도구 · Send가 그 아래 한 줄에 놓인다.

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

## 4. 검증

- 단위: `src/session/__tests__/task-ledger-dropped.test.ts`(ledger), `src/conversation/__tests__/dashboard-task-view-client.test.ts`(결말 · 이전 계획 · 탭 · 답변 순서 · 입력 · 자세히), `src/conversation/__tests__/dashboard-command-attachments.test.ts`(명령 경로 첨부).
- 브라우저: `scripts/screenshot-task-view.ts` — 1280 라이트/다크, 390 라이트에서 배치 순서, 기본 접힘, 렌더된 답변과 Raw, 탭 범위, 키보드, 이전 계획, 자세히 켜기/끄기, 여러 줄 · 붙여넣은 이미지 · 전송 본문, 가로 넘침 없음.
