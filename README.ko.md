<h1 align="center">soma-work</h1>

<p align="center">
  <strong>Slack용 AI 코딩 어시스턴트 — Claude Code SDK 기반</strong>
</p>

<p align="center">
  <a href="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml"><img src="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/2lab-ai/soma-work/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Claude_Code_SDK-0.3-7C3AED?logo=anthropic&logoColor=white" alt="Claude Code SDK" />
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

## soma-work란?

Slack 워크스페이스의 모든 대화를 AI 코딩 세션으로 전환하는 멀티테넌트 봇입니다. DM을 보내거나, 채널에서 멘션하거나, 스레드에서 대화하면 — 봇이 코드를 읽고, PR을 리뷰하고, Jira 이슈를 정리하고, 컨텍스트를 유지한 채 솔루션을 작성합니다.

```
You:   이 PR 리뷰해줘 https://github.com/org/repo/pull/42
Bot:   [diff 분석, 소스 코드 읽기, 라인별 리뷰 코멘트 작성]

You:   PROJ-1234 이슈 요약해줘
Bot:   [Jira 이슈 조회, 관련 PR/코드 분석, 경영진 보고용 요약 생성]

You:   이 함수 성능 개선해줘 [파일 첨부]
Bot:   [업로드된 코드 분석, 병목 지점 식별, 최적화된 버전 제안]
```

## 문서

- 현재 아키텍처, 스펙, trace, archive, 문서 라우팅 규칙은 [docs map](./docs/README.md)에서 시작합니다.
- 장기 유지할 결정은 [ADR index](./docs/adr/README.md)에 정리합니다.
- 완료/아카이브된 작업은 [completed work ledger](./docs/archive/completed-work.md)에서 추적합니다.
- AI agent 친화적인 프로젝트 문서 정리 리서치는 [docs/research](./docs/misc/research/2026-05-18-ai-agent-docs-organization.md)에 있습니다.
- Slack Block Kit/API 제약은 [docs/misc/reference/slack-block-kit.md](./docs/misc/reference/slack-block-kit.md)에 유지합니다.

## zworkflow 플러그인

soma-work가 기본으로 싣는 Claude Code 플러그인 `zworkflow`는 [`src/local/`](./src/local/)에 있습니다.
내 Claude Code에서는 `/plugin marketplace add 2lab-ai/soma-work`와 `/plugin install zworkflow@soma-work`로
설치합니다. 설치·업데이트·훅, 그리고 플러그인 없이 `using-intentfirst`·`using-ssot` 스킬만 복사하는 경로는
[zworkflow 플러그인 README](./src/local/README.ko.md)에 있습니다.

---

## ✨ 주요 기능

### 🔀 워크플로우 자동 분류

사용자 입력을 분류하여 최적의 워크플로우로 자동 라우팅합니다 — 수동 선택 불필요.

| 워크플로우 | 트리거 | 동작 |
|-----------|--------|------|
| **PR Review** | GitHub PR URL | 코드 리뷰 + 인라인 코멘트 |
| **PR Fix & Update** | `수정해줘` + PR URL | 수정 구현 → 커밋 → 푸시 |
| **PR Docs** | `문서화` + PR URL | Confluence 문서 생성 |
| **Jira Planning** | Jira 이슈 + `계획` | 태스크 분해 & 작업 분할 |
| **Jira Summary** | Jira 이슈 + `요약` | 경영진 보고서 생성 |
| **Jira Brainstorming** | Jira 이슈 + `브레인스토밍` | 아이디어 발산 & 종합 |
| **Jira → PR** | Jira 이슈 + `PR 만들어줘` | 이슈에서 PR 자동 생성 |
| **Deploy** | 배포 관련 요청 | 배포 워크플로우 오케스트레이션 |
| **Onboarding** | 신규 유저 / `onboarding` | 인터랙티브 가이드 셋업 |
| **Default** | 기타 모든 입력 | 범용 코딩 어시스턴트 |

세션 핸드오프 전용 entrypoint(`z-plan-to-work`, `z-epic-update`)도 있습니다 (#695) — free-text 분류가 아니라 `CONTINUE_SESSION` 핸드오프로 진입합니다. Source of truth: [`somalib/model-commands/session-types.ts`](./somalib/model-commands/session-types.ts)의 `WorkflowType`, [`src/dispatch-service.ts`](./src/dispatch-service.ts)의 `VALID_WORKFLOWS`; 프롬프트 파일은 [`src/prompt/workflows/`](./src/prompt/workflows/).

### 🎭 천재 페르소나

봇의 성격과 사고방식을 전환합니다. 각 페르소나는 문제 해결에 고유한 접근법을 제공합니다.

```
/z persona set einstein    → 제1원리 물리학적 사고
/z persona set linus       → 무자비한 코드 리뷰
/z persona set feynman     → "간단히 설명 못하면 이해 못한 것"
/z persona set vonneumann  → 수학적 정밀함
```

사용 가능: `default` · `linus` · `buddha` · `davinci` · `einstein` · `elon` · `feynman` · `jesus` · `newton` · `turing` · `vonneumann` — source of truth: [`src/persona/`](./src/persona/)

### 🔌 MCP 도구 생태계

MCP 호환 서버(stdio/SSE/HTTP)를 연결하여 Claude의 능력을 무한히 확장합니다. 호출 통계와 예상 소요 시간을 내장 추적합니다.

### 🔐 인터랙티브 권한

Slack 네이티브 버튼/폼 UX로 권한 승인, 선택지, 세션 관리를 처리합니다. 신뢰된 사용자를 위한 바이패스 모드 지원.
어느 모드에서든 비관리자 세션은 샌드박스 셸이 쓸 수 있는 곳에만 파일을 씁니다: 네이티브 `Write` / `Edit` / `NotebookEdit` 도구, 새 git worktree, 작업 디렉터리 전환(worktree로, 또는 서브에이전트의)도 Bash처럼 작업 디렉터리와 사용자 전용 임시 디렉터리로 묶이고, `Artifact`는 자기 스크래치패드에만 저장합니다(`out_dir`는 거부). 세션이 그 디렉터리로 가는 길에 심볼릭 링크를 만들어도 경계는 옮겨지지 않고(링크를 치울 때까지 네이티브 쓰기가 멈춥니다), 한 디렉터리의 두 표기(`/tmp`와 `/private/tmp`)는 같은 곳으로 봅니다.

### 📎 파일 분석

이미지(JPG/PNG/GIF/WebP), 텍스트, 코드 파일을 Slack에서 직접 업로드 가능. 파일당 50MB 제한.

### 🆕 대시보드에서 작업 시작

대시보드의 **New task** 버튼(PC는 상단 바·`N` 단축키, 휴대폰은 플로팅 버튼)으로 작성 창을 엽니다. 모델(공유 풀 잔여량 배터리 표시), effort, Slack 채널, 작업 단위 `autogoal`·`autoz` 토글, 지시문, 첨부(파일·붙여넣은 스크린샷·휴대폰 카메라·음성 녹음)를 정하면, 고른 채널의 새 스레드에 내 메시지로 작업이 시작되어 진행이 Slack에 그대로 보입니다. 채널 목록은 내가 속한 repo 매핑 채널이고, 기본값은 마지막으로 명령을 내린 채널입니다. `autoz`를 켜면 지시 끝에 `$autoz`가 붙습니다.

### 🖼️ 대시보드 산출물

모델이 Slack으로 보낸 파일(HTML 리포트, PNG, WAV·음성, 영상, PDF, 텍스트)과 마크다운 최종 답변이 웹 대시보드에 모두 보인다: 세션 카드의 칩, 펼친 카드의 썸네일 스트립, 세션 패널 공통 서피스의 스트립과 답변마다 그 턴의 파일. 마우스를 올리면 미니맵 미리보기, 누르면 풀사이즈 뷰어(HTML은 샌드박스에서 실행, 오디오는 카드에서 바로 재생). 기능 도입 전 업로드는 세션 작업 로그에서 백필한다.

### 📎 대시보드의 지시 첨부

지시와 함께 보낸 파일(스크린샷, PDF, 텍스트, 음성, 영상)이 웹 대시보드에서 그 지시와 함께 보인다. 모델 산출물과 섞이지 않는다. 세션 패널에서는 지시 글 위에 놓인다(80px 이미지 타일, 4개를 넘으면 "+N", 종류·크기가 있는 파일 카드, 음성은 그 자리에서 재생). 펼친 카드의 지시 행에는 작게, 카드 앞면에는 클립 아이콘과 개수가 나오고, 패널 공통 서피스의 "지시 첨부" 줄(기본은 접힘)에 세션의 모든 파일이 모인다. 누르면 산출물과 같은 뷰어가 열리고 그 지시의 파일끼리 넘겨 본다. 모델이 일하는 중에 보낸 메시지는 모델이 읽은 시점에 파일과 함께 기록된다. 영상과 음성도 사본을 남겨 대시보드에서 재생된다. 봇이 받지 못한 파일(50 MB 초과, 다운로드 실패)도 Slack 링크와 함께 표시된다. 업로드된 HTML·SVG·텍스트는 대시보드에서 실행되지 않는다.

### 🧾 직접 입력하지 않은 턴은 한 줄로

세션 패널 대화창, 작업 로그, 인박스 카드를 펼쳤을 때의 지시 / 응답에서 soma-work가 스스로 보낸 턴은 원본 프롬프트 대신 **System** 이름과 톱니 아바타로 한 줄로 보인다(유저 이름이 아니다) — 언제, 뱃지, 무엇을 했는지: **자동 압축** / **압축** (`/compact`), **시스템 재시작**, **자동 재시도**(오류 뒤), **Goal #2/10**(goal continuation), **크론**(cron 실행), **세션 갱신**(`/renew` 저장·불러오기), **백그라운드 재개 #1/6**(백그라운드 작업이 아직 돌고 있어 턴을 이어 간 경우), 그 밖의 호스트 턴은 **자동 입력**. 줄을 누르면 세부 사항과 원본 프롬프트가 펼쳐진다. 압축이 도는 동안은 경과 시간과 예상 시간(대화의 직전 압축 시간, 없으면 2분 30초), 진행률 막대를 보여 주고, 끝나면 압축 전 → 후 토큰과 걸린 시간을 보여 준다. 지시가 발동한 스킬(`$skill`, autoskill)은 지시 아래 뱃지로 보인다 — `local:using-ssot · ≈1.1K tokens`(추정치). 뱃지를 누르면 그 스킬 본문이 펼쳐진다. 인박스 카드에서는 압축이 도는 동안의 진행률과 끝난 뒤의 결과가 응답 자리에 보이고, 펼친 줄이나 스킬은 카드가 다시 그려져도 펼쳐진 채로 남는다. 예전 턴은 텍스트로 판별한다. 이 변경 전에 기록된 `/compact`는 누가 보냈는지 남아 있지 않아 **압축**으로 보인다.

### 🔑 GitHub 연동

GitHub App(권장) 또는 Personal Access Token 인증. 자동 토큰 갱신 지원.

### 🖥️ 웹 대시보드

대시보드(`/dashboard`, Slack 로그인)는 모든 세션을 카드로 보여주고, 세션 소유자가 바로 조작할 수 있게 한다.

- **세 서피스, 세 가지 일**: 세션 하나가 세 군데에 나오고, 각자 다른 질문에 답한다. **카드**는 분류다 — 나를 기다리나, 움직이나(제목, 여기 있는 이유, 진행 중 task, 서브에이전트 펄스, 토큰·비용, 상태와 멈춘 카드가 그 상태에 든 지 얼마인지(질문 대기는 질문이 온 때부터, 완료는 작업이 끝난 때부터), 60%를 넘으면 호박색·80%를 넘으면 빨간색이 되는 컨텍스트, 상태(열림·초안·머지됨·닫힘)가 붙은 PR 배지). **펼친 카드**는 그 자리에서 처리하며, 섹션이 카드 상태를 따른다: 질문·권한 요청이 먼저, 실행 중이면 task 창·에이전트(compact 행)·최근 지시 ↔ 응답, 끝났으면 응답·산출물·goal — 그 뒤 goal 한 줄, 짧은 참조, 모델·effort. 액션(☆ Star, 잠든·보관된 카드의 살리기, Stop / Close / Trash, Slack)은 접힌 면 바로 밑 첫 줄이다. 카드의 숫자를 다시 그리지 않는다. 펼친 카드는 언제나 오른쪽에 **상세 카드**(세션 패널)를 둔다 — 여러 개를 펼치면 상세 카드가 덱으로 쌓이고 우상단 ‹ n / m ›로 넘기며 뒤 카드의 가장자리가 보인다(✕나 카드 접기로 뺀다). 스펙: [`.prd/15-dashboard-detail-deck-spec.md`](./.prd/15-dashboard-detail-deck-spec.md). **세션 패널**은 파악과 조종이며 태스크 뷰로 배치된다: 세션 상태·실시간 시간·액션 하나가 있는 머리 칩, 태스크 공통 서피스(세션 정보 — 요약 한 줄과 링크, 필요하면 모든 숫자 —, goal, 입력 필요, 산출물), 그 아래 에이전트마다 탭 하나(Main은 항상 맨 왼쪽에 고정, 그 뒤로 서브에이전트)와 그 에이전트의 Tasks(접힘 — 실제로 실행된 태스크를 순서대로, 태스크마다 시작 → 종료·툴·토큰·비용, 행을 누르면 상세와 이전 문구; 그 뒤 남은 계획)와 세 뷰: **Chat**(지시와 답변, 기본 — 최신 지시와 답변, 이전 대화는 버튼 하나 뒤; 답변은 Slack 봇 이름, 하네스가 보낸 입력은 **System**), 작업 로그, 오른쪽 끝의 에이전트 트리. 패널은 맨 위에서 열려 서피스·탭·최신 답변이 한 화면에 들어온다. 답변은 렌더된 답변 자체가 보이고, 요약과 원문(raw)은 맨 아래에 있다. 그 밑에 모델·effort와 여러 줄 입력창이 있고, 붙여넣거나 끌어놓은 이미지·파일·음성 녹음을 함께 보낸다. 기본은 중요한 정보만 보이고, 우상단 **자세히** 토글 버튼을 켜면 모든 섹션이 펼쳐진다 — 세션 정보 전체, 산출물 썸네일, 모든 대화(기기에 저장). 스펙: [`.prd/14-dashboard-task-view-spec.md`](./.prd/14-dashboard-task-view-spec.md). 필드마다 전부 보이는 집은 한 곳이고, 다른 곳에서는 숫자·배지·그 집으로 가는 링크다. 스펙: [`.prd/13-dashboard-three-surfaces-spec.md`](./.prd/13-dashboard-three-surfaces-spec.md).
- **메인과 서브에이전트 — 하나의 재귀 트리**: 카드 하나가 메인 에이전트, 곧 세션 에이전트 트리의 루트다. 메인이 `Agent` 도구로 띄운 SDK 서브에이전트(와 그들이 다시 띄운 것)는 그 밑의 같은 타입 노드다 — 각자 상태·시간·툴 호출 수와 자기 태스크 목록·작업 로그를 갖고, 어느 깊이든 같은 렌더러로 그린다(방향키로 다루는 ARIA 트리). 사이드 패널은 메인을 포함한 어떤 노드로든 드릴한다 — 경로(`메인 › A1 Explore › A3 …`), 그 노드의 헤더와 하위 트리 — 부모의 작업 로그에서는 띄운 자식마다 실시간 블록이 보인다. 메인의 태스크·로그가 서브의 것과 섞이지 않는다. 스펙: [`.prd/12-dashboard-agent-tree-spec.md`](./.prd/12-dashboard-agent-tree-spec.md).
- **task마다 어떻게 됐는지**: TodoWrite는 목록을 통째로 바꾸므로, 새 계획은 이전 계획에서 끝나지 않은 단계를 뺀다. task ledger가 단계가 목록에서 빠진 시각을 기록하고, Tasks는 단계마다 완료·진행 중·멈춤(시작했지만 세션이 멈춤)·대기·중단(진행 후 새 계획에서 빠짐)·실행 안 됨(시작 전에 빠짐)을 보여 준다. 지금 도는 단계만 스피너가 돈다. 이전 계획은 개수가 적힌 한 줄로 접혀 있고, 열면 새 계획으로 교체된 시점별로 묶여 나온다. 카드의 task 개수는 실행 안 된 단계를 세지 않는다. 스펙: [`.prd/14-dashboard-task-view-spec.md`](./.prd/14-dashboard-task-view-spec.md) §3.
- **폰·폴더블·PC**: 배치는 기종이 아니라 화면 크기를 따른다. 840px 미만에서는 세션 패널이 전체 화면 시트이고, 840px 이상(펼친 iPhone Duo·Galaxy Z Fold8, 태블릿, PC)에서는 보드 옆에 붙는다 — 보드가 살아 있어서 패널을 연 채로 다음 카드를 누를 수 있다. 보드는 폭이 840px 이상이면 3칸이 모두 보이고, 그보다 좁으면 옆으로 넘겨 본다. 접거나 펴거나 돌리면 카드가 새 자리로 움직인다(동작 줄이기 설정에서는 페이드만). 패널에서 에이전트 탭은 스크롤 영역 맨 위에 남고, 입력창은 화면 키보드 위에 남는다. 창이 840×1000보다 작으면 CRON 레인이 접힌 채로 시작하고(머리줄과 응답을 기다리는 잡만), LLM 가용량은 항상 접힌 채로 시작한다(공급자별 칩에 두 기준을 합계 대비 계정분과 %로, `Claude 지금 5.2/16.0 33% · 주 5.6/16.0 35%`, 840px 미만에서는 두 줄까지 감싼다). 그래서 보드가 첫 화면에 보이고, 펼치기·접기 선택은 그 기기에 저장된다. 기기 크기와 출처: [`docs/misc/research/2026-10-24-dashboard-device-viewports.md`](./docs/misc/research/2026-10-24-dashboard-device-viewports.md).
- **최상단에서 모델·effort 원클릭 변경**: top bar에 새 세션의 기본 모델과 기본 effort가 있다. 값을 고르면 바로 저장된다 — Slack `model set <m>`, `effort <level>`과 같은 설정이다. 세션 패널이 보드 옆에 붙어 있으면 "이 세션에도 적용"(기본 켜짐)으로 그 세션도 함께 바뀐다(폰에서는 패널 시트가 top bar를 덮으므로 패널 자체의 컨트롤을 쓴다).
- **세션별 모델·effort**: 카드와 세션 패널 맨 위에서 그 세션만 바꾼다(`%effort <level>`과 같은 범위). 다음 턴부터 적용되고, 모델이 effort를 낮춰 실행하면 실제 실행 값을 함께 보여준다.
- **퍼미션 요청**: 턴이 퍼미션 요청(Slack의 "🔐 Permission Request" 카드 — 예: 위험 명령 규칙에 걸린 Bash 명령)에서 멈추면 그 카드가 NEEDS YOU로 옮겨지고, 카드와 세션 패널에 같은 요청이 뜬다: 도구, 파라미터, 매칭된 규칙, **Approve / Deny / Explain / Approve & disable rule (this session)**. 파라미터를 보고 응답할 수 있는 건 요청이 걸린 본인뿐이다 — Slack 버튼과 같은 규칙. Slack과 대시보드는 한 경로(`src/permission-prompt-response.ts`)로 응답하므로 먼저 누른 쪽이 이기고, 나머지는 이미 응답됐다고 안내받는다. API: `GET /api/dashboard/session/:key/permission/:approvalId`, `POST /api/dashboard/session/:key/permission` (auth + CSRF).
- **즐겨찾기와 살리기**: 펼친 카드나 세션 패널의 **☆ Star**로 세션을 고정한다. 별 단 카드는 ★로 시작하고, 자기 컬럼 맨 위에 놓이며(DONE에서는 날짜 그룹 위의 **★ Starred** 그룹, 별 단 크론 실행은 CRON 레인이 아니라 보드에 남는다), 계속 살아 있다 — 일이 끝났어도 sleep이나 보관(archive)으로 넘어가지 않고 만료 예고도 받지 않는다. 잠든 카드나 보관된 카드에 별을 달면 먼저 살린다. 잠든 카드와 보관된 카드의 **살리기**는 세션을 되살려 대시보드나 Slack에서 대화를 이어가게 한다: 잠든 세션은 깨우고, 보관된 세션은 같은 SDK 세션·작업 폴더·대화 기록으로 돌아온다 — 대화 기록(transcript)이 있고 작업 폴더가 그 기록으로 이어진다는 것이 확인될 때만이고, 아니면 거절 이유를 보여준다. 작업 폴더 안의 파일은 복구되지 않는다. 별을 떼면 일반 수명 주기로 돌아가되 유휴 시간을 처음부터 다시 센다. 별 단 세션은 휴지통으로 옮길 수 없고, Close는 그대로 세션을 끝낸다. API: `POST /api/dashboard/session/:key/star` `{ starred }`, `POST /api/dashboard/session/:key/revive` (세션 소유자, auth + CSRF; 보관된 카드는 그 보관본의 소유자).
- **설정 페이지**(`/dashboard/settings`, top bar의 "⚙ 설정"): Slack 명령으로 바꿀 수 있는 개인 설정 전부를 그룹(모델·effort, 출력, 알림, 목표, 자동 스킬, 계정, 권한)으로 보여준다. 선택형은 바로 저장되고, 직접 입력하는 값은 저장 버튼으로 저장한다. 행마다 기본값, 다를 때 "기본값으로" 되돌리기, 같은 일을 하는 Slack 명령이 보인다. 위험한 변경(bypass, 샌드박스 끄기, 네트워크 허용 목록 끄기)은 먼저 묻고, 관리자 전용 행은 잠긴 이유를 보여준다.
- **인터페이스 소리**(기본 꺼짐): 보드와 설정 페이지의 테마 스위치 옆 스피커로 켠다. `@2lab.ai/ui`의 짧은 소리가 난다 — 탭·옵션을 바꾸면 딸깍, 대화상자·서랍이 열리면 바람 소리, 내가 한 일이 성공하면 부드러운 화음. 소리는 Cuelume가 Web Audio로 그 자리에서 합성한다. 오디오 파일이 없고, 플레이어는 소리를 켠 뒤에만 불러온다. 선택은 브라우저마다 저장된다(`soma-sound`, 테마처럼). 마우스를 올릴 때, 스트리밍 출력, 내가 일으키지 않은 갱신에는 소리가 나지 않는다.
- **기억 탭**(`/dashboard/settings#memory`, top bar의 "🧠 기억"): 개인 기억 전부를 보고 고친다 — 에이전트 노트(`MEMORY.md`)와 사용자 프로필(`USER.md`)은 항목마다 한 줄, 용량 미터, 추가·수정·삭제(되돌리기)·모두 지우기(개수를 밝힌 확인); 지식 페이지(agent / sites / concepts / projects / cron)는 Current와 History 전체를 편집·생성·삭제; 관찰 기록(에피소딕)은 날짜별로 항목을 고치거나 지우고 오늘 기록에 메모를 더한다. 모든 편집은 탭이 불러온 revision 조건부라, 그사이 에이전트나 Slack이 바꿨으면 그 부분을 다시 불러오고 작성하던 내용은 남긴다. host 프로세스·model-command MCP 서브프로세스·대시보드가 같은 사용자별 메모리 잠금(`somalib/model-commands/memory-lock.ts`)을 써서 편집과 에이전트 기록이 서로를 지우지 않는다. API: `/api/memory/*`, 로그인 본인만, 쓰기는 auth + CSRF.
- **개인 설정 API**: `GET /api/settings`, `PATCH /api/settings/:key`로 Slack 명령으로 바꿀 수 있는 개인 설정 전부를 로그인한 본인 것만 읽고 바꾼다. 쓰기는 Slack과 같은 검증기·`/z` 카드 핸들러를 거치고, 대시보드에 없는 Slack 설정 명령이 생기면 계약 테스트가 실패한다.

### 🤖 서브 에이전트 (부분 구현 · 프로비저닝 미지원)

서브 에이전트는 같은 프로세스 안에서 각자의 Slack App·Socket Mode 연결·세션 레지스트리를 갖는다.
다만 **추가 서브 에이전트를 만드는 지원 경로는 오늘 존재하지 않는다.** `somawork setup`은 프로파일의
주 Slack App 하나만 만들고, 옛 스크립트 두 개는 대체재가 아니다: `scripts/provision-agent.ts`는
아무것도 프로비저닝하지 않는 deprecation 래퍼이고(configuration token 저장·OAuth 콜백 수집·수동
app-token 프롬프트는 금지된 자격증명 경로라 삭제됨), `scripts/create-agent.sh`는 아직 돌지만
터미널에서 토큰을 받아 평문 config에 쓴다 — **자격증명을 발급·복사·저장하는 용도로 실행하지 마라.**
둘 다 패키징된 런타임에 들어가지 않는다.

상태·아키텍처 노트: [docs/misc/guides/how-to-new-agent.md](./docs/misc/guides/how-to-new-agent.md)
(설치 안내서가 아니다). 스키마의 정본은 `src/types.ts`의 `AgentConfig`.

---

## 아키텍처

```
┌───────────────────────────────────────────────────┐
│                    Slack Events                     │
│              (DM / Mention / Thread)                │
└──────────────────────┬────────────────────────────┘
                       │
                ┌──────▼──────┐
                │ SlackHandler │  ← Facade
                └──────┬──────┘
                       │
          ┌────────────┼────────────────┐
          │            │                │
   ┌──────▼──────┐ ┌──▼───────┐ ┌─────▼──────┐
   │ EventRouter │ │ Command  │ │  Stream    │
   │             │ │ Router   │ │ Processor  │
   └──────┬──────┘ └──┬───────┘ └─────┬──────┘
          │            │                │
          │     ┌──────▼──────┐  ┌─────▼──────┐
          │     │  Command    │  │  Pipeline  │
          │     │  Handlers   │  │ input →    │
          │     └─────────────┘  │ session →  │
          │                      │ stream     │
          │                      └─────┬──────┘
          │                            │
   ┌──────▼──────────────────────────▼──────┐
   │              ClaudeHandler               │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
   │  │ Session  │ │ Prompt   │ │ Dispatch │ │
   │  │ Registry │ │ Builder  │ │ Service  │ │
   │  └──────────┘ └──────────┘ └──────────┘ │
   └──────────────────┬───────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
   │   MCP   │  │ GitHub  │  │ Permis- │
   │ Manager │  │  Auth   │  │  sion   │
   └─────────┘  └─────────┘  └─────────┘
```

**Key Facades** — `SlackHandler`, `ClaudeHandler`, `McpManager`, `AgentManager`가 복잡한 서브시스템 위에 단순한 인터페이스를 제공합니다. 각 모듈은 단일 책임 원칙을 따릅니다. 전체 컴포넌트 와이어링은 [architecture.md](./docs/misc/reference/architecture.md)를 참고하세요.

---

## 명령어

목적이 겹치지 않는 4개의 prefix family:

| Prefix | 범위 | 지속성 | 예시 |
|--------|------|--------|------|
| `/z <topic> …` | 기본 명령어 surface (필요 시 Block Kit UI) | 유저 전역 | `/z persona set linus` |
| `%<sub> …` | **현재 세션 전용** — 저장 없이 오버라이드 | 휘발성 (`new`/`renew` 시 초기화) | `%model opus` |
| `$<skill>` / `$<plugin>:<skill>` | **강제 스킬 발동** (`SKILL.md` 로드, `compact` 이상에서 RPG 배너 출력 — `minimal`에서는 게시하지 않음; 세션에 대화가 있으면 대시보드 작업 로그에 기록) | 메시지 단위 | `$z`, `$stv:new-task` |
| naked text | bare 명령 또는 채팅 / 워크플로우 디스패치 | n/a | `sessions`, `new`, `fix PR 123` |

주요 `/z` 명령: `help` · `cwd` · `mcp` · `bypass` · `persona` · `model` · `verbosity` · `session` · `new`/`renew` · `close` · `restore` · `context`/`compact` · `link` · `onboarding` · `admin` · `cct` · `auth` · `marketplace` · `plugin` · `skill` · `report`

- 출력 수준(`/z verbosity`, 세션 한정 `%verbosity`): `minimal` · `compact` · `detail` · `verbose`. 기본값은 `minimal`이다 — 스레드에는 task list(메인 에이전트의 것 — 서브에이전트의 목록은 대시보드의 그 서브에이전트 항목에 있다), 질문/승인, 최종 답변, 오류만 남고, 모델의 실시간 작업 설명·도구 호출·압축 공지·스킬 발동 배너(`$skill`·autoskill 포함)는 대시보드 작업 로그로 간다.

- Fable 5.1·Opus 5.5(`claude-opus-5-5`, Claude Code 2.1.280 이상 필요) 지원을 위해 SDK를 `0.3.284`(네이티브 Claude Code `2.1.284`)로 고정한다. 스트리밍 턴은 `CLAUDE_CODE_ENABLE_TASKS=false`와 `MCP_CONNECTION_NONBLOCKING=0`을 강제하여 기존 Slack TodoWrite 스냅샷 처리와 첫 턴 MCP 초기화를 유지한다. 이 호환성 설정은 stream-options builder가 관리하며 운영자 설정으로 덮어쓰지 않는다.
- 모델 별칭 `fable`·`fable[1m]`·`fable-5-1`은 `claude-fable-5-1[1m]`을 선택한다. 1M 컨텍스트와 750k 자동 압축 기본값을 유지하며, 버전을 지정한 `fable-5`는 기존 `claude-fable-5[1m]`을 선택한다.
- 모델 별칭 `opus`·`opus[1m]`·`opus-5-5`는 `claude-opus-5-5[1m]`(1M 컨텍스트, 750k 자동 압축 기본값)을 선택한다. 버전을 지정한 `opus-5`/`opus-5[1m]`은 기존 Opus 5 id를 그대로 선택한다.
- naked `cron`/`schedule`(크론/스케줄): 잡별 모델/출력 대상 드롭다운 + 삭제 버튼이 달린 인터랙티브 카드로 목록·수정. 텍스트 명령도 지원 — `cron model <name> <default|opus|fable|fast|모델>` (default = 만든 사람의 현재 모델, opus/fable = 실행 시점의 최신 opus/fable) · `cron target <name> <channel|dm|thread>` · `cron delete <name>`; admin은 전체 유저 잡을 owner와 함께 보고 `<@owner>` 후행 인자 또는 카드에서 직접 타인 잡을 수정. 커맨드로 라우팅되므로 autogoal이 삼키지 않음.
- **대시보드의 크론 실행**: 크론 발동이 만든 세션은 `Direct (skipDispatch)`가 아니라 잡 이름으로 시작한다. 이 제목은 임시 제목이라 첫 명확한 제목(턴 요약·연결된 이슈/PR)이 오면 교체되고, 카드는 새 제목을 페이드인한다. 카드 머리 왼쪽에 **CRON** 뱃지가 붙고, 보드 칸 위의 **CRON 레인**에 들어간다 — 잡마다 타일 1개(스케줄 문장, cron은 UTC 기준·다음 실행·최근 실행 막대 ✓성공 ✗실패 ●실행 중 ▲응답 필요 ◌세션 없음)와 그 잡의 최신 실행 카드. **지난 실행**을 누르면 잡의 보관된 실행(잡당 최근 20회)을 세션·작업 로그·대화 기록·Slack 스레드와 연결해 보여 주는 서랍이 열린다(`GET /api/dashboard/cron`). 기존 세션에 주입된 크론 실행은 그 세션을 레인으로 옮기지 않는다.
- **대시보드 LLM 가용량 (2026-10-25)**: 통계 줄과 Agent inbox 사이에 섹션이 있다(`GET /api/dashboard/capacity`, llmux 조회 30초 캐시·페이지 60초 재조회). 섹션은 모든 창에서 접힌 채로 시작하고, 펼치기 선택은 기기에 저장된다. 접힌 칩은 구독 프로바이더마다 두 기준을 합계 대비 계정과 %로 보여 준다(`Claude 지금 5.2/16.0 33% · 주 5.6/16.0 35%`). 840px 미만에서는 칩 줄이 감기고, 칩은 두 값 사이에서만 끊긴다. 가장 오래된 측정이 하루를 넘었거나 계정의 80% 미만만 반영된 칩에는 경고가 붙는다(`Codex 주 2.37/2.4 99% ⚠ 5일 전 · 3/5 반영`). 막대 두 줄(위 5시간, 아래 일주일)을 고른 근거는 리서치 문서에 있다: [`docs/misc/research/2026-10-25-capacity-dual-window.md`](./docs/misc/research/2026-10-25-capacity-dual-window.md). 펼치면 프로바이더마다 단순한 카드 하나가 나온다(Claude·Codex, API 키 풀은 플랜 단위가 없어 제외). 카드 구성은 다음과 같다. **막대 두 줄**: `5시간 · 지금 쓸 수 있음`(5h·주간 잔여 중 작은 쪽, 차단 중이면 0)과 `일주일 · 이번 주 남음`을 각각 `x / 합계 계정 · %`로 보여 주고, "다음 +1.0계정 · 1시간 23분 후" 한 줄을 붙인다(얼마나·언제만 쓰고, 막대 자기 리셋이 아닐 때만 원인을 붙인다. 예: "· 차단 해제". 계정 이름은 툴팁에 있다. 일주일 한도에 묶인 5시간 막대는 "일주일 한도에 묶임 · 다음 …"). 폰에서는 막대가 카드 폭 전체를 쓴다. Codex는 일주일 막대만 있다. "계정"은 티어 가중치(x20 = 1, x5 = ¼, $500 = 1, $200 = 0.4)에 잔여를 곱한 정규화 추정이고 토큰 수가 아니다. %는 실제 비율로 계산해 가득일 때만 100%로 표시하고, 합계로 반올림되는 수는 소수 둘째 자리까지 보인다(`2.37 / 2.4 · 99%`). **흐린 공개 줄 한 줄**: 0이 아닌 것만 보여 준다(`16/17 반영(차단 6 포함) · 제외 1(보류) · 측정 4시간 전`). **타임라인 하나**: 지금→24h(폭 55%)→7d 축에서 ●는 5시간 막대가 늘어나는 것(라벨 위), ◆는 일주일 막대가 늘어나는 것(라벨 아래)이고 막대와 같은 색이다. 겹치는 라벨은 하나로 합친다. 계정별 리셋을 시간순으로 재생해 계산한다. 7일 안에 5시간 쪽으로 늘어날 양이 없으면 범례에 "늘어날 양 없음"이라고 적고, 0.05 미만의 작은 증가만 있으면 그 합을 "+0.1계정 미만"이나 "+0.1계정"처럼 적는다(막대의 "다음" 줄, 칩 툴팁과 같은 말). llmux 0.2.26부터는 계정별 플랜을 llmux가 직접 알려 준다(Claude `rate_limit_tier` = `default_claude_max_20x` 등, Codex `plan_type` = `pro`($200)·`promax`($500)). 그래서 설정 없이 티어가 잡힌다. 우선순위는 `SOMA_LLMUX_ACCOUNT_TIERS` → llmux가 알려 준 플랜 → 기본값이다. `SOMA_LLMUX_ACCOUNT_TIERS`(`group:name=tier`, 예: `claude:ai7=x20,claude:ai12=x5`)는 기본값(Codex `ai1`·`ai2` = Pro $200, `ai5`·`ai6` = Pro $500) 위에 덮인다. llmux의 `max`만으로 x5/x20을 추측하지 않는다. 매핑이 없는 **Claude** 계정은 Max x20으로 세고 그렇다고 밝힌다(카드 `티어 미지정 15(x20 가정)`, 접힌 칩 `⚠ x20 가정 15`). 그래서 매핑이 없는 호스트도 풀을 보여 준다(2026-10-26). 매핑이 없는 Codex 계정은 합계에서 뺀다(`제외 1(티어 미지정)`). 스펙: [`.prd/12-cron-lane-and-llm-capacity-spec.md`](./.prd/12-cron-lane-and-llm-capacity-spec.md)
- **배포 후 QA**: 호스트에 `post-deploy` 스킬을 제공하는 환경 플러그인(`acme-env` 같은)을 설치하면, deploy 워크플로우가 7단계로 배포가 확인된 repo마다 배포 세션 안에서 배포 후 QA를 돈다(설정: [docs/runbook/add-new-deploy.md](docs/runbook/add-new-deploy.md) §8.5). `qa=max`는 실제 QA가 보는 범위(커버리지 매트릭스)로 이슈마다 케이스를 먼저 계획하고, 케이스마다 사전 조건(계정·테스트 데이터·쓰기 권한·설정)을 확인한다. 하나라도 부족하면 어떤 케이스도 돌리기 전에 미충족 표를 올리고 요청자에게 한 번 묻는다. 선택지는 제공하기, 없이 진행하기(그 케이스는 blocked로 남고 PASS가 될 수 없음), 이슈 건너뛰기다. 답이 올 때까지 실행은 `deployed, QA incomplete: waiting for precondition confirmation`으로 끝난다. 리포트는 사전 조건을 맨 앞에 보여 준다.
- **환경 스킬은 어드민 승인**: 배포 때 설치된 환경 플러그인의 스킬은 어드민(`ADMIN_USERS`)은 바로, 그 밖의 사람은 어드민이 허용했을 때만 돈다. 어드민이 아닌 사람의 `$plugin:skill`이나 모델의 `Skill` 호출은 멈추고, 어드민 전원에게 버튼 4개(1회 허용 = 그 스레드만, 이 스킬 항상 허용, 모든 환경 스킬 항상 허용, 거부)가 붙은 DM이 간다. 허용되면 요청한 턴을 다시 보내 이어서 실행한다(자세히: [docs/runbook/add-new-deploy.md](docs/runbook/add-new-deploy.md) §8.5).
- **배포 릴리즈노트**: 배포가 끝나면 deploy 워크플로우가 `local:release-notes`로 노트를 쓰고 repo마다 `release_notes` 디렉티브를 하나 낸다. 호스트는 채널 루트에 짧은 헤더(`repo target · 버전` + TL;DR 최대 3줄)를, 그 스레드에 전문을 잘림 없이 나눠 올린다. 채널은 운영자가 호스트 `.env`의 `SOMA_RELEASE_NOTES_CHANNELS`로 정한다(예: `acme/app@deploy/dev2=C0DEV2CHAN1,*=session`). `owner/repo@branch` 또는 `branch`가 정확히 맞으면 그 채널, `*=session`이면 매핑 안 된 배포는 배포 세션 채널, `*`가 없으면 매핑 안 된 배포는 배포 스레드에만 남는다. 설정하지 않으면 예전처럼 배포 세션 채널이다. 게시가 실패해도 다른 채널 루트로 옮기지 않고 경고와 함께 배포 스레드에 남긴다.
- naked `key` (= `auth key`): 자기 전용 llmux 클라이언트 키 + 로컬 Claude Code(`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`)와 Codex(`OPENAI_BASE_URL`/`OPENAI_API_KEY`) 실행법을 DM으로 받음. 같은 유저는 항상 같은 키 — 봇 사용량과 로컬 사용량이 한 테넌트로 계측된다. 모든 유저 사용 가능(자기 키이므로), 시크릿은 DM으로만 전달.
  Codex 안내는 안내된 서버 주소의 `/v1`과 같은 테넌트 키를 사용한다. `codex --model … -c …` 명령 전체를 복사해야 기존 ChatGPT 로그인이나 다른 provider 설정이 있어도 명시한 Responses provider가 환경변수의 키를 사용한다. 환경변수는 현재 터미널에 적용되며, Codex 설정 파일과 로그인 정보는 덮어쓰지 않는다. 다음 llmux 세션도 같은 명령으로 시작한다. [Codex 게이트웨이 인증 문서](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway).
- `auth`(= `/z auth`) **용량 오버뷰**: llmux 모드에서 `auth` 카드는 admin 포함 모두에게 **읽기 전용 용량 오버뷰**가 기본이다. Claude → Codex → Grok 순 그룹화(그 외 그룹은 알파벳순, 그룹 안은 스케줄러 선택 순서); 그룹 합계는 5h/7d(및 `7d-fable` 등 scoped weekly) 잔여 비율을 **정규화된 계정분**(계정 1개 100% = 1, 플랜 가중치 없음)으로 합산 — llmux status 계약에는 utilization 비율과 리셋 시각만 있고 토큰 분모가 없으므로 토큰 잔고를 표시하거나 암시하지 않는다(누적 토큰은 소비량으로만 표기); 리셋은 Slack 로컬 절대 시각 + 남은 시간으로 표시하고 다음 리셋의 창·계정·회복 %p를 예고(추가 사용이 없을 때만 유효); 미제공·만료·범위 밖 값은 0%/100%가 아니라 "미제공"으로 표시, scoped 창은 공통 한도와 분리, cold/null 값은 합계에서 제외하고 측정 커버리지(n/m)를 표기; Grok/API-key는 llmux가 원시 요청·토큰 카운트를 비율로 접고 리셋 없는 버스트 한도에 합성 단기 리셋을 붙이는데, 카드는 그 합성 리셋을 실제 쿼터 창 카운트다운처럼 보여주지 않고 억제한다; Codex 수동 리셋 카운터(보유/현재 적용 가능)는 읽기 전용 표시(자동 사용 없음); 관리 컨트롤(모드 전환·설정·추가·삭제·계정 전환)은 [어드민 모드] 버튼 **명시 클릭**으로만 열리고 위조/스테일 admin 클릭은 서버에서 readonly로 강등; 큰 풀은 고정 페이지 크기로 페이지네이션되어 모든 계정에 도달 가능하며 Refresh/페이징은 현재 보기와 페이지를 유지한다. 레거시 CCT를 `auth` 안에 표시할 때도 페이지를 나누며, 변경 버튼과 모달 제출 후 같은 auth 보기로 돌아온다. 별도 `cct` 명령은 기존 동작을 유지한다. 상세: [README.md의 Auth capacity overview](./README.md#auth-capacity-overview) · 스펙/업스트림 검증: [`.prd/07-auth-capacity-spec.md`](./.prd/07-auth-capacity-spec.md)
- **llmux SDK 인증 격리**: llmux 모드에서 soma-work는 Claude Agent SDK의 Messages 경로를 사용하며, 모델 카탈로그의 Codex 백엔드 모델도 이 경로로 실행한다. SDK 호출마다 선택한 llmux URL과 키를 함께 전달한다. 테넌트 lease가 있으면 개인 키를 쓰고, lease가 없는 보조 호출 등은 기존 공유 키로 폴백한다. 부모 환경의 OAuth·Bearer 인증, 다른 프로바이더 선택 플래그, 인증용 커스텀 헤더는 이 선택을 덮어쓰지 못하며 그 외 커스텀 헤더는 유지된다. [SDK 인증 계약](docs/current/spec/llmux-sdk-auth.md)을 참고한다.
- 메시지 명령 `autocompact`(메시지 맨 앞에 `/`를 붙인 `/autocompact`도 같은 파서로 허용; 별도 등록된 Slack slash command는 아님): **세션 스코프** auto-compact 토큰 임계값. 인자 없이 호출하면 현재 유효값과 출처를 보여주고, `800k`/`800K`/`0.8M`/`800000`/bare `800`(천 단위로 해석)으로 설정하며, `reset`으로 모델 기본값으로 되돌린다 — 세션에 저장되어 재시작에도 유지. 우선순위(높은 게 이김): 세션 오버라이드 → 모델 기본값(`fable`/`opus` 1M 프로파일 750k·750k, bare `gpt-5.6-sol` 340k, 리터럴 `gpt-5.6-sol[1m]` 1M 프로파일 600k, `astra`/`gpt-6`/`gpt6` 및 `gpt-6-astra[1m]` 1M 프로파일 600k, bare 리터럴 `gpt-6-astra`는 272k 컨텍스트에 240k, `sol`/`sol[1m]`/`gpt-6.1` 및 `gpt-6.1-sol[1m]` 1M 프로파일 600k, bare 리터럴 `gpt-6.1-sol`은 272k 컨텍스트에 240k, `grok-4.6` 450k, bare `claude-opus-5`는 기본값 없이 레거시 퍼센트로 폴백) → 레거시 유저 퍼센트(현재 모델 컨텍스트 윈도우 기준 환산). `grok-4.6[1m]`은 실재하지 않는 모델이라 항상 `use grok-4.6`으로 명시 거부된다. `/compact-threshold <percent>`는 **deprecated** 호환 어댑터 — 현재 모델 기준으로 퍼센트를 환산해 `/autocompact`와 같은 세션 토큰 슬롯에 쓰고, 변환 성공 시 옛 유저 전역 퍼센트 저장값을 지운다; 모델의 안전 최대치를 넘는 변환은 조용히 clamp하지 않고 명시적으로 실패한다. 자동 compact는 harness의 임계값 체커가 유일한 트리거이며, SDK 자체의 native autocompact는 모든 해석된 모델 프로파일에서 꺼져 있다. 체커는 턴이 끝날 때만이 아니라 턴의 API 호출이 들어올 때마다 돈다. 턴 도중 임계값을 넘으면 그 턴을 멈추고 대화를 압축한 뒤 작업을 자동으로 이어 간다(goal 세션은 goal 루프가 이어 감). 이미 임계값을 넘은 상태로 시작한 턴은 멈추지 않고 다음 턴에 압축한다. 재시작 뒤에는 저장된 컨텍스트가 임계값 이상인 세션이 다음 턴 전에 압축한다. 모델별 정확한 기본값 표는 [README.md의 Auto-compact thresholds 섹션](./README.md#auto-compact-thresholds-autocompact--compact-threshold)을 참고하세요.
- 모든 `gpt-…[1m]` 프로파일은 앞으로 추가되는 지원 모델까지 Sol과 같은 1M 윈도우, SDK 차단선 977k, 자동 압축 600k를 적용한다. 모델별 임계값을 따로 등록할 필요가 없다. 지원하지 않는 모델 변형을 생성하거나 명시적으로 선택한 bare 모델 ID를 바꾸지는 않으며, 세션 오버라이드는 계속 우선한다.
- 제공자가 compact 요청을 거절하면 실패 안내에 인증정보를 가린 오류 상세를 표시한다. Slack 표시 길이를 넘으면 생략 사실을 알리며, 서버 로그에는 가림 처리한 전체 원인을 남긴다. 실패 안내는 압축 성공을 뜻하지 않는다.
- 전체 명령어 표와 마이그레이션 히스토리(#506, #508)는 [README.md의 Commands 섹션](./README.md#commands)을 참고하세요.
- naked(bare `[cmd] [args]`) 명령의 source of truth: [`CommandRouter`](./packages/slack/src/commands/command-router.ts) 핸들러 체인. 비-admin DM에서 받는 입력은 [`isDmAllowedForNonAdmin`](./packages/slack/src/z/whitelist.ts)이 정한다. `persona linus` 같은 bare 형태는 그대로 실행된다 — #506 Phase 1의 tombstone 힌트는 #531에서 제거됐다.
- `$model` 등 legacy `$` 세션 설정은 deprecation grace period 동안만 허용 (경고 후 `%` 사용 안내)

---

## 실행 경로 두 가지

들어오는 길은 **두 개**이고, 서로 대체 가능하지 않다.

| 경로 | 무엇인가 | 지금 상태 |
|---|---|---|
| **패키지 온보딩** — `somawork setup` | 설치된 불변 macOS ARM64 런타임 + 재개 가능한 터미널 위저드 하나. llmux를 띄우고, Slack을 인가하고, 런타임 토큰을 직접 발급·수집하고, 프로파일을 materialize하고, doctor 게이트를 돌리고, 백그라운드 서비스를 설치한다. | 컨트롤러·위저드·런타임 번들은 **이 브랜치에 구현되어 있고 로컬 staged-bundle 스모크를 통과한다.** Homebrew/xbrew 포뮬러는 **미배포**이고, clean-user·실 Slack 리시트는 아직 없다. 아래 상태 박스를 먼저 읽어라. |
| **소스 개발** — 클론 후 실행 | 기존 경로: 레포 클론, Slack 앱 수동 생성, 로컬 `.env`에 토큰, `npm run dev`. | 오늘 지원되는 경로이며, 컨트리뷰터와 현행 플릿 배포가 쓰는 길이다. |

### 패키지 경로의 상태

이 경로의 명령을 입력하기 전에 먼저 읽어라.

**이 브랜치에 반영되었고 로컬에서 검증된 것**

- `somawork setup | doctor | status | service | profile | sessions`, 프로파일 materialization, Slack 매니페스트 훅, staged 런타임 번들 계약.
- `npm run stage:bundle && npm run smoke:setup-package`는 번들을 stage한 뒤 **staged** 컨트롤러를 외부 소비자처럼 실행한다: 격리된 `SOMAWORK_HOME`, 가짜 `HOME`, `PATH`에 Homebrew 없음, 프로바이더 호출 없음. 필수 경로·모드, 금지 파일 스캔, `--help` / `--version`, 패키징된 매니페스트에 대한 비공개 Slack 매니페스트 훅, 단일 JSON 문서 출력, 프로파일 격리, 그리고 런타임 루트에 아무것도 쓰지 않는 0700/0600 프로파일 materialization을 검사한다.

**아직 하지 않은 것 — 위를 릴리스로 읽지 마라**

- **배포된 Homebrew 포뮬러도, xbrew 레시피도 없다.** 오늘 `brew install somawork`는 해석되지 않는다. 패키징·릴리스 아카이브·탭 변경은 아직 실행되지 않은 별도 워크스트림이다.
- **clean-machine 설치도, 실제 Slack 워크스페이스 앱 생성도, 실제 `launchd` 리시트도 없다.** 위의 모든 것은 개발 머신의 staged 번들에 대해 증명된 것이다.
- 플랫폼은 **macOS ARM64 전용**. Linux 지원은 주장하지도 구현하지도 않았다.

### A. 패키지 온보딩 — 출하 후의 지원 경로

```bash
xbrew install somawork-preview   # 또는: xbrew install somawork   ← 포뮬러 아직 미배포
somawork setup                   # 런타임이 정확히 하나 설치돼 있으면 프로파일 자동 추론
```

`somawork setup`이 온보딩의 전부다. 재개 가능하다 — 중단 후 다시 실행하면(또는 `somawork setup --resume`) 오래된 마커를 믿는 대신 세계를 다시 검증한다.

무엇을 대신 해주고, 무엇을 **묻지 않는가**:

| 단계 | 담당 | 절대 묻지 않는 것 |
|---|---|---|
| Claude / Codex 프로바이더 인증 | llmux, 공식 브라우저 OAuth 플로우 | API 키 |
| Slack 앱 생성 + 설치 | Slack CLI 티켓/챌린지 → 패키징된 앱 매니페스트 | 매니페스트 붙여넣기 |
| Slack 런타임 자격증명 | Slack CLI 자체 훅에서 프로파일 전용 Unix 소켓을 통해 `0600 secrets.env`로 수집 | `xoxb-` / `xapp-` 복붙 |
| Signing secret | 사용하지 않음 — 매니페스트가 Socket Mode를 켠다 | signing secret |
| 프로파일 config·프롬프트·데이터 디렉터리 | 패키징된 `config.default.json`과 `.system.prompt.example`에서 materialize | 손으로 쓴 `.env` |
| 백그라운드 서비스 | 프로파일별 launchd user agent | plist |

컨트롤러 명령:

| 명령 | 용도 |
|---|---|
| `somawork setup [--profile preview\|production] [--resume]` | 온보딩 실행/재개. |
| `somawork doctor [--profile <p>] [--json]` | 프로파일 진단. `--json`은 정확히 한 개의 문서를 내고, detail에 파일시스템 경로가 없다. |
| `somawork status [--profile <p>] [--json]` | 프로파일·서비스 상태. `status --json`에는 절대 경로(plist, pid 파일, 로그 디렉터리)가 **들어간다** — 공개 이슈에 붙이기에는 `doctor --json`보다 덜 안전하다. |
| `somawork service <install\|start\|stop\|restart\|status> [--profile <p>]` | 백그라운드 서비스 관리. |
| `somawork profile <list\|show> [--profile <p>] [--json]` | 설치된 프로파일 조회. `profile remove`는 이번 릴리스에서 제공하지 않고 거부한다. |
| `somawork sessions <list\|show> [--profile <p>] [filters]` | 아카이브된 세션 조회. |
| `somawork help` · `somawork version` | 둘 다 런타임·프로파일·프로바이더를 건드리지 않고 답한다. |

프로파일은 완전히 격리된다 — `preview`와 `production`은 한 머신에 공존하며 경로도 서비스 식별자도 공유하지 않는다:

| | `preview` | `production` |
|---|---|---|
| config | `~/.config/somawork/profiles/preview` | `~/.config/somawork/profiles/production` |
| data | `~/.local/share/somawork/preview` | `~/.local/share/somawork/production` |
| state | `~/.local/state/somawork/preview` | `~/.local/state/somawork/production` |
| 서비스 레이블 | `ai.2lab.somawork.preview` | `ai.2lab.somawork.production` |

`SOMAWORK_HOME`이 프로파일 루트를 덮어쓰며, 격리 테스트용으로 지원되는 오버라이드다. `SOMA_HOME`은 **deprecated** 별칭으로만 허용되고, 둘 다 있으면 `SOMAWORK_HOME`이 이긴다.

**레거시 setup 진입점은 호환 shim이지 두 번째 설치 경로가 아니다.** `scripts/setup-wizard.sh`, `scripts/setup-wizard-macos.sh`, `scripts/new-deploy-setup.sh`는 deprecation 안내를 출력하고 `exec somawork setup`한다. 더 이상 토큰을 수집하지 않고, 레포 상대 `.env`를 쓰지 않고, `/opt/soma-work`를 만들지 않는다. `scripts/provision-agent.ts`도 마찬가지로 hard deprecation 래퍼다.

### B. 소스 개발 경로

지금 기여할 때 쓰는 경로이자, 현행 플릿 배포가 서 있는 경로다. 변경 없음.

#### 1. 클론 & 설치

```bash
git clone https://github.com/2lab-ai/soma-work.git
cd soma-work
npm install
```

#### 2. Slack App 수동 생성

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. [`infra/slack/slack-app-manifest.json`](./infra/slack/slack-app-manifest.json) 내용 붙여넣기

   > **매니페스트의 앱 이름은 `Somawork`** (이전: `[DEV] Claude Code Bot`). 예전 파일로 만든 앱에
   > 이 매니페스트를 붙여넣으면 **해당 앱과 봇 이름이 바뀐다.** 기존 이름을 유지하려면 저장 전에
   > `name` / `display_name` 두 필드를 직접 수정하라.
3. 앱 생성 후:
   - **OAuth & Permissions** → Bot User OAuth Token 복사 (`xoxb-...`)
   - **Basic Information** → `connections:write` 스코프로 App-Level Token 생성 (`xapp-...`)
   - **Basic Information** → Signing Secret 복사

> 패키지 경로에서는 이 과정이 전부 자동이다 — 위저드가 Slack CLI를 몰고 토큰을 출력 없이 수집한다.
> 이 절이 남아 있는 이유는 소스 체크아웃에는 매니페스트를 읽어올 패키징된 런타임이 없기 때문이다.

#### 3. 환경 설정

```bash
cp .env.example .env
```

```env
# 필수
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
# SLACK_SIGNING_SECRET=...  # optional: HTTP signature verification only (Socket Mode does not need it)
BASE_DIRECTORY=/path/to/code/

# 선택
ANTHROPIC_API_KEY=...              # Claude Code 구독 없을 때만 필요
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA..."
GITHUB_INSTALLATION_ID=12345678
GITHUB_TOKEN=ghp_...               # GitHub App 미설정 시 폴백
CLAUDE_CODE_USE_BEDROCK=1          # AWS Bedrock 사용
CLAUDE_CODE_USE_VERTEX=1           # Google Vertex AI 사용
DEBUG=true
```

#### 4. MCP 서버 설정 (선택)

`config.json`의 `mcpServers` 섹션을 수정:

```bash
cp config.example.json config.json
```

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}
```

`config.json`의 최상위 `ui` 키로 스레드 헤더·턴 종료 카드·대시보드 카드
헤더의 표시 항목을 커스터마이즈할 수 있습니다. 기본값은 저장소 루트의
`config.default.json`(자동 생성, 직접 수정 금지)에서 확인하고, 원하는
섹션만 `config.json`에 복사해 수정하세요. 스키마: [docs/ui-surfaces.md](docs/ui-surfaces.md).

#### 5. 실행

```bash
npm run dev                        # 개발 (watch mode)
npm start                          # 개발 (tsx)
npm run build && npm run prod      # 프로덕션
```

---

## 배포

배포 모델이 두 개 공존하며, 경로도 서비스 레이블도 setup 절차도 공유하지 않는다.
위의 두 경로 중 어디에 서 있는지로 고른다.

| | 플릿 배포 (레거시, 현행) | 프로파일 패키지 (신규) |
|---|---|---|
| 단위 | 노드의 `/opt/soma-work/<env>` 체크아웃 또는 동기화된 번들 | 설치된 불변 런타임 + 사용자별 프로파일 |
| 설치 | GitHub self-hosted runner, 손으로 만든 Slack 앱, 노드의 `.env` | `somawork setup` |
| 서비스 | `scripts/service.sh` → `ai.2lab.soma-work[.<env>]` | `somawork service install` → `ai.2lab.somawork.<profile>` |
| 런북 | [docs/runbook/add-new-deploy.md](./docs/runbook/add-new-deploy.md) | 이 README의 패키지 온보딩 절 |
| 상태 | 현행 — 돌아가는 플릿이 쓰는 것 | 구현됨, 미배포 (위 상태 박스 참조) |

### 플릿 배포 — Docker

```bash
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml logs -f
```

### 플릿 배포 — macOS LaunchAgent

```bash
./scripts/service.sh install     # LaunchAgent 설치
./scripts/service.sh start       # 서비스 시작
./scripts/service.sh logs follow # 실시간 로그
```

서비스 식별자: `ai.2lab.soma-work` — 크래시 시 자동 재시작.

> ⚠️ **개발 중에는 `scripts/service.sh`를 사용하지 마세요.** 같은 Slack 토큰으로 여러 인스턴스가 실행되면 메시지 충돌이 발생합니다.

### 두 모델이 공유하는 런타임 번들

`scripts/deploy/stage-bundle.sh`가 불변 트리 하나를 stage한다. 플릿 배포는 그것을
노드로 rsync하고, 패키지 경로는 런타임 루트로 설치한다. 데몬, 서비스 supervisor,
실행 가능한 컨트롤러 엔트리, 그리고 세 개의 canonical setup asset
(`config.default.json`, `.system.prompt.example`, `infra/slack/slack-app-manifest.json`)을
담고, 자격증명·프로파일 상태·테스트·소스맵·TypeScript 소스는 담지 않는다.

```bash
npm run build
npm run stage:bundle              # → .deploy-bundle
npm run smoke:deploy-bundle       # 배포 + 워크스페이스 패키지 계약
npm run smoke:setup-package       # setup/런타임 계약, 외부 소비자 관점
```

`smoke:setup-package`는 staged 트리의 임시 하드링크 사본도 변형한다 — setup asset과
런타임 엔트리를 하나씩 제거하고, 금지 파일을 하나씩 주입한다. 그래서 green이면
소스 체크아웃에 파일이 있다는 뜻이 아니라 *번들*이 계약을 만족한다는 뜻이다.

---

## GitHub 연동

### GitHub App (권장)

1. [GitHub Developer Settings](https://github.com/settings/apps)에서 App 생성
2. 필요 권한: **Contents** (RW), **Issues** (RW), **Pull Requests** (RW), **Metadata** (R)
3. Private Key 생성 및 다운로드
4. 대상 리포지토리에 App 설치, Installation ID 확인
5. `.env`에 `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` 설정

### Personal Access Token (폴백)

1. GitHub Settings → Developer Settings → Personal Access Tokens
2. 필요 스코프: `repo`, `read:org`
3. `.env`에 `GITHUB_TOKEN` 설정

GitHub App이 설정되어 있으면 우선 사용됩니다. 없으면 PAT으로 자동 폴백.

---

## 프로젝트 구조

> 숫자 카운트는 반드시 drift합니다 — 디렉토리를 직접 확인하세요. 전체 컴포넌트 와이어링: [docs/misc/reference/architecture.md](./docs/misc/reference/architecture.md)

```
src/                                # TypeScript 소스
├── agent-manager.ts                # 서브 에이전트 라이프사이클 관리
├── agent-instance.ts               # 개별 에이전트 (Slack App + Handler)
├── agent-runtime/                  # Claude Agent SDK 실행 런타임
├── slack/                          # Slack 통합 레이어
│   ├── actions/                    # 인터랙티브 액션 핸들러
│   ├── commands/                   # 명령어 핸들러
│   ├── pipeline/                   # 스트림 처리 파이프라인
│   ├── directives/                 # 채널/세션 링크 디렉티브
│   ├── formatters/                 # 출력 포맷터
│   └── z/                          # /z 명령어 surface + 비-admin DM 입력 게이트
├── auth/                           # CCT lease + query env 주입
├── conversation/                   # 대화 기록 & 리플레이
├── model-commands/                 # 모델 커맨드 카탈로그 & 검증
├── mcp/                            # MCP 서버 관리
├── github/                         # GitHub App 인증 + Git CLI
├── permission/                     # 권한 서비스 + Slack UI
├── plugin/                         # 플러그인 시스템 (마켓플레이스, 캐시)
├── prompt/                         # 시스템 프롬프트 + workflows/
├── persona/                        # 봇 페르소나
├── sandbox/                        # 실행 샌드박스 게이트
├── metrics/                        # 토큰/비용 텔레메트리
├── notification-channels/          # Slack · DM · Telegram · Webhook 라우팅
└── local/                          # Claude Code SDK 확장 (skills/, agents/, hooks/)

packages/                           # 워크스페이스 패키지
├── mcp-servers/                    # 내장 MCP 서버 (agent, cron, model-command, devops-tools, ...)
├── devops-broker/                  # 별도 OS 유저 브로커: gh 토큰 + Cloudflare forge 키 보관, 자체 Slack 앱으로 admin 승인
├── common/ · slack/ · process-shared/ · test-utils/

somalib/                            # soma 계열 공유 라이브러리
services/a2t/                       # 음성→텍스트 Python worker
infra/                              # docker / slack manifest / claude 설정
scripts/                            # 배포 스테이징, 스모크, service.sh, deprecation shim
├── deploy/stage-bundle.sh          # 불변 런타임 번들 생성
├── smoke/setup-package.js          # staged 번들 setup/런타임 계약
└── setup/                          # DEPRECATED 셸 수집기 — 도달 불가, 번들에 없음

docs/                               # 아키텍처 & 기능 스펙 — docs/README.md에서 시작
```

## 설계 원칙

1. **Facade Pattern** — 4개의 Facade(`SlackHandler`, `ClaudeHandler`, `McpManager`, `AgentManager`)로 복잡한 서브시스템 단순화
2. **Single Responsibility** — 모듈당 하나의 책임
3. **Pipeline Architecture** — 입력 전처리 → 세션 초기화 → 스트림 실행
4. **Workflow Dispatch** — 입력 분류 → 전문 워크플로우 프롬프트 적용
5. **Append-Only Messages** — 메시지 편집 대신 새 메시지 (안정성)
6. **Session-Based Context** — 스레드별 세션 유지 + 자동 재개
7. **Error Isolation** — 서브 에이전트 장애가 메인 봇으로 전파되지 않음
8. **Dependency Injection** — 주입된 의존성으로 테스트 용이성 확보
9. **Hierarchical CWD** — Thread > Channel > User 작업 디렉토리 우선순위

---

## 테스트

```bash
npx vitest run          # 단일 실행
npx vitest              # 감시 모드
```

테스트 커버리지: 이벤트 라우팅, 스트림 처리, 명령어 파싱, 권한 검증, 도구 포맷팅, 세션 관리, 액션 핸들러, 파이프라인 처리, MCP 통합, 멀티 에이전트 라이프사이클 등.

---

## 문제 해결

| 증상 | 확인 사항 |
|------|-----------|
| 봇이 응답하지 않음 | 로그 확인 (`DEBUG=true`), Slack 토큰 유효성, 채널 초대 여부 |
| 인증 오류 | API 키 확인, Socket Mode 활성화 여부, 토큰 만료 |
| 포맷 깨짐 | Markdown → Slack mrkdwn 변환 한계 케이스 |
| 세션 충돌 | 같은 Slack 토큰으로 다중 인스턴스 실행 여부 |
| 패키지 경로: 프로파일 이상 | `somawork doctor --profile <p>` — 위저드가 직접 돌리는 게이트이며, detail에 파일시스템 경로가 없어 `doctor --json`은 이슈에 붙여도 안전하다 |
| 패키지 경로: 서비스 미기동 | `somawork status --profile <p>` — 이쪽은 절대 경로를 **출력한다** |
| `brew install somawork`가 안 됨 | 정상이다. 아직 배포된 포뮬러가 없다 — [패키지 경로의 상태](#패키지-경로의-상태) 참조 |

---

## 라이선스

[MIT](./LICENSE)
