# User Workflows

Slack 채널에서 @제갈량(봇)을 통해 실행하는 주요 워크플로우.

> **전제**: 특정 Slack 채널과 GitHub repo가 sticky로 연결되어 있음.

---

## 공통 파이프라인 (모든 워크플로우의 진입점)

모든 유저 메시지는 동일한 파이프라인을 거쳐 워크플로우별 프롬프트로 분기된다.

```
 Slack Message: "@제갈량 {text}"
 │
 ▼
┌──────────────────────────────────────────────────────────────────┐
│  InputProcessor  (src/slack/pipeline/input-processor.ts)         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • 첨부 파일 다운로드 & 처리                               │  │
│  │ • 커맨드 프리픽스 라우팅 (cwd, mcp, model 등)             │  │
│  │ • 텍스트 + 파일 → effectiveText 생성                      │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  SessionInitializer  (src/slack/pipeline/session-initializer.ts) │
│                                                                  │
│  1. validateWorkingDirectory()                                   │
│     └─ /tmp/{userId}/ 존재 확인                                  │
│                                                                  │
│  2. getOrCreateSession()                                         │
│     └─ SessionRegistry에서 channel+thread 기반 조회/생성         │
│                                                                  │
│  3. ┌─── needsDispatch? ───────────────────────────────────┐     │
│     │ Yes                                                  │     │
│     ▼                                                      │     │
│  ┌──────────────────────────────────────────────────────┐  │     │
│  │  DispatchService.dispatch(text)                      │  │     │
│  │  (src/dispatch-service.ts)                           │  │     │
│  │                                                      │  │     │
│  │  ┌────────────────────────────────────────────────┐  │  │     │
│  │  │ Model: claude-haiku-4-5 (빠르고 저렴)         │  │  │     │
│  │  │ System: dispatch.prompt (분류 규칙)            │  │  │     │
│  │  │ User: "{text}" (유저 원문)                     │  │  │     │
│  │  │                                                │  │  │     │
│  │  │ → 패턴 우선순위 매칭:                          │  │  │     │
│  │  │   1. deploy 패턴       → deploy                │  │  │     │
│  │  │   2. "plan" + Jira     → jira-planning         │  │  │     │
│  │  │   3. "fix" + Jira      → jira-create-pr        │  │  │     │
│  │  │   4. "fix" + PR        → pr-fix-and-update  ★  │  │  │     │
│  │  │   5. Confluence + PR   → pr-docs-confluence    │  │  │     │
│  │  │   6. Jira issue        → jira-brainstorming ★  │  │  │     │
│  │  │   7. GitHub issue      → jira-brainstorming    │  │  │     │
│  │  │   8. Linear issue      → jira-brainstorming    │  │  │     │
│  │  │   9. Jira board        → jira-executive-summary│  │  │     │
│  │  │  10. GitHub PR         → pr-review          ★  │  │  │     │
│  │  │  11. 그 외             → default               │  │  │     │
│  │  └────────────────────────────────────────────────┘  │  │     │
│  │                                                      │  │     │
│  │  Output (JSON):                                      │  │     │
│  │  { "workflow": "pr-review",                          │  │     │
│  │    "title": "PR #42 리뷰",                           │  │     │
│  │    "links": { "pr": "https://..." } }                │  │     │
│  └──────────────────────────────────────────────────────┘  │     │
│     │                                                      │     │
│     └──────────────────────────────────────────────────────┘     │
│                                                                  │
│  4. transitionToMain(workflow, title)                             │
│     └─ session.workflow = "pr-review" | "pr-fix..." | ...        │
│                                                                  │
│  5. checkRepoChannelMatch()                                      │
│     └─ PR 워크플로우: repo↔channel 매핑 확인                     │
│     └─ 틀린 채널 → 이동/유지 선택 UI (halt)                      │
│                                                                  │
│  6. createBotInitiatedThread()                                   │
│     └─ 봇이 루트 메시지를 생성하고 새 스레드에서 작업 시작        │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  StreamExecutor  (src/slack/pipeline/stream-executor.ts)         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ PromptBuilder.buildSystemPrompt(userId, workflow)          │  │
│  │ (src/prompt-builder.ts)                                    │  │
│  │                                                            │  │
│  │   ┌──────────────────────────────────────────────────┐     │  │
│  │   │ 1. loadWorkflowPrompt(workflow)                  │     │  │
│  │   │    └─ src/prompt/workflows/{workflow}.prompt      │     │  │
│  │   │    └─ {{include:./common.prompt}} 처리            │     │  │
│  │   │                                                  │     │  │
│  │   │ 2. appendLocalSystemPrompt()                     │     │  │
│  │   │    └─ .system.prompt (운영 설정, 모든 WF에 주입) │     │  │
│  │   │                                                  │     │  │
│  │   │ 3. loadPersona(userPersona)                      │     │  │
│  │   │    └─ src/persona/{persona}.md                   │     │  │
│  │   │    └─ <persona>...</persona> 태그로 래핑         │     │  │
│  │   │                                                  │     │  │
│  │   │ 4. processVariables()                            │     │  │
│  │   │    └─ {{llm_chat_config}} → MCP 모델 설정        │     │  │
│  │   │    └─ {{user.email}}, {{user.displayName}} 등    │     │  │
│  │   └──────────────────────────────────────────────────┘     │  │
│  │                                                            │  │
│  │ + getChannelDescription(channel)                           │  │
│  │   └─ <channel-description>...</channel-description>        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Claude Code SDK query({                                         │
│    prompt:       유저 메시지 + 파일 + speaker tag,               │
│    systemPrompt: 위에서 조립된 전체 시스템 프롬프트,              │
│    cwd:          /tmp/{userId}/,                                 │
│    model:        session.model (sonnet-4-5 기본),                │
│    resume:       session.sessionId (기존 세션 이어가기),          │
│    mcpServers:   MCP 설정 (GitHub, Jira, model-command 등),      │
│  })                                                              │
│                                                                  │
│  ← 스트리밍 응답 → Slack 메시지로 변환                            │
└──────────────────────────────────────────────────────────────────┘
```

### 시스템 프롬프트 조립 구조

```
┌─────────────────────────────────────────────────┐
│              최종 System Prompt                  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │  common.prompt (공통 베이스)               │  │
│  │  • 기본 역할 정의 (400년 경력 풀스택 엔지니어)│
│  │  • 소스 clone 규칙 (유니크 폴더)          │  │
│  │  • fast_fail (디스크 용량 체크)            │  │
│  │  • model-command-tool 우선 규칙            │  │
│  │  • MCP 부하 모델 설정 (codex, gemini)      │  │
│  └───────────────────────────────────────────┘  │
│                    +                             │
│  ┌───────────────────────────────────────────┐  │
│  │  {workflow}.prompt (워크플로우별 지시)      │  │
│  │  • pr-review.prompt                       │  │
│  │  • pr-fix-and-update.prompt               │  │
│  │  • jira-brainstorming.prompt              │  │
│  │  • jira-create-pr.prompt                  │  │
│  │  • ...                                    │  │
│  └───────────────────────────────────────────┘  │
│                    +                             │
│  ┌───────────────────────────────────────────┐  │
│  │  .system.prompt (운영 설정, 선택적)        │  │
│  │  • 모든 워크플로우에 자동 주입             │  │
│  └───────────────────────────────────────────┘  │
│                    +                             │
│  ┌───────────────────────────────────────────┐  │
│  │  <persona> (유저별 페르소나)               │  │
│  │  • src/persona/{name}.md                  │  │
│  └───────────────────────────────────────────┘  │
│                    +                             │
│  ┌───────────────────────────────────────────┐  │
│  │  <channel-description> (채널 컨텍스트)     │  │
│  │  • 채널에 연결된 repo, 팀 정보 등          │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## 1. PR 코드 리뷰 워크플로우

**트리거**: `@제갈량 {pr_link}`
**디스패치**: `dispatch.prompt` → pattern #10 (GitHub PR URL) → `pr-review`
**프롬프트**: `src/prompt/workflows/pr-review.prompt` + `common.prompt`

```
 User: "@제갈량 https://github.com/org/repo/pull/42"
 │
 ▼
┌──────────────────────────────────────────────────────────────┐
│ Dispatch (Haiku 4.5)                                         │
│ → { "workflow": "pr-review", "title": "PR #42 리뷰",        │
│     "links": { "pr": "https://...pull/42" } }               │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ Channel Routing Check                                        │
│ PR repo ↔ channel 매핑 확인                                  │
│ ┌──────────┐  ┌──────────────────────┐  ┌─────────────────┐ │
│ │ 매핑 일치│  │ 매핑 불일치          │  │ 매핑 없음       │ │
│ │→ 봇 스레드│  │→ 이동/유지 버튼 표시│  │→ 유지 버튼 표시 │ │
│ │  생성    │  │  (session halt)      │  │  (session halt) │ │
│ └──────────┘  └──────────────────────┘  └─────────────────┘ │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ StreamExecutor + pr-review.prompt                            │
│                                                              │
│ System Prompt가 모델에게 지시하는 내용:                       │
│                                                              │
│  Step 1: /github-pr 스킬로 PR 데이터 수집                   │
│          (메타데이터, 리뷰, 코멘트, 변경 파일)                │
│                                                              │
│  Step 2: git clone → 유니크 작업 폴더 생성                   │
│          $WORKING_DIR/20260101_1532_repo_pr_42/              │
│                                                              │
│  Step 3: review-pr 스킬 실행                                 │
│          (correctness, tests, security 포커스)                │
│                                                              │
│  Step 4: 결과 파싱 & 정규화                                  │
│          • priority 보정 (없으면 P2)                         │
│          • 중복 제거 (file, line, title 기준)                │
│                                                              │
│  Step 5: 이슈 분류 — Priority × Switching Cost               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Priority: P0(블로킹) P1(긴급) P2(일반) P3(낮음)    │    │
│  │  Tier: tiny(~5줄) small(~20줄) medium(~50줄)        │    │
│  │        large(~100줄) xlarge(~500줄)                  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Step 6: Decision Gate                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ tiny/small (< ~20줄):                                │    │
│  │   → 3명 다수결 자율 결정 (유저에게 안 물어봄)         │    │
│  │   → oracle-reviewer + oracle-gemini-reviewer 병렬     │    │
│  │   → 2/3 동의시 확정                                  │    │
│  │                                                      │    │
│  │ medium+ (>= ~50줄):                                  │    │
│  │   → UIAskUserQuestion으로 개별 질문                   │    │
│  │   → 3명 리뷰 합의 결과 + 추천안 포함                  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Step 7: GitHub에 리뷰 제출                                  │
│          mcp__github__create_pull_request_review              │
│          • 코드 라인 참조 코멘트                             │
│          • P0/P1 없으면 → APPROVE                            │
│          • P0/P1 있으면 → REQUEST_CHANGES                    │
│                                                              │
│  Step 8: CI 체크 루프                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ CI pending → 1분 대기 → 재조회 (반복)                │    │
│  │ CI failure → 실패 분석 → switching cost 분류          │    │
│  │   tiny/small → 자율 수정 가능 판단                    │    │
│  │   medium+   → UIAskUserQuestion                      │    │
│  │   "이 PR에서 고친다" → CONTINUE_SESSION → pr-fix      │    │
│  │ CI success → merge gate로 이동                       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Step 9: Merge Gate (조건 충족시만)                           │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ 조건: unresolved 없음 + approve 확보 + CI 성공        │    │
│  │                                                      │    │
│  │ → AS-IS / TO-BE / 머지 이유 / Approver 정보 안내      │    │
│  │ → UIAskUserQuestion:                                 │    │
│  │   [merge_now]          지금 머지                      │    │
│  │   [rerun_review]       다시 리뷰 (CONTINUE_SESSION)   │    │
│  │   [wait_for_other]     다른 리뷰어 대기               │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 워크플로우 전환 (pr-review ↔ pr-fix-and-update)

```
┌──────────────┐  CONTINUE_SESSION   ┌──────────────────┐
│  pr-review   │ ──────────────────→ │ pr-fix-and-update │
│              │ forceWorkflow:      │                  │
│              │ "pr-fix-and-update" │                  │
│              │ ←────────────────── │                  │
│              │  CONTINUE_SESSION   │                  │
│              │  forceWorkflow:     │                  │
│              │  "pr-review"        │                  │
└──────────────┘                     └──────────────────┘

CONTINUE_SESSION payload:
{
  "commandId": "CONTINUE_SESSION",
  "params": {
    "prompt": "new fix <PR_URL>",
    "resetSession": true,
    "dispatchText": "<PR_URL>",
    "forceWorkflow": "pr-fix-and-update"
  }
}
```

---

## 2. 이슈 → 구현 → PR (반자동 워크플로우)

**트리거**: `@제갈량 {jira_or_github_issue_link}`
**디스패치**: `dispatch.prompt` → pattern #6/#7/#8 (이슈 URL) → `jira-brainstorming`
**프롬프트**: `src/prompt/workflows/jira-brainstorming.prompt` + `common.prompt`

```
 User: "@제갈량 https://atlassian.net/browse/PTN-123"
 │
 ▼
┌──────────────────────────────────────────────────────────────┐
│ Dispatch (Haiku 4.5)                                         │
│ → { "workflow": "jira-brainstorming", "title": "PTN-123...", │
│     "links": { "issue": "https://...PTN-123" } }            │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ StreamExecutor + jira-brainstorming.prompt                    │
│                                                              │
│  Step 1: 이슈 컨텍스트 파악                                  │
│          mcp__jira__getJiraIssue로 이슈 상세 조회             │
│          • 제목, 설명, 댓글, AC, 관련 에픽                    │
│                                                              │
│  Step 2: 코드베이스 분석                                     │
│          • 관련 repo 식별 (채널 매핑 활용)                    │
│          • git clone → 소스 분석                             │
│          • 현재 구조와 패턴 파악                              │
│                                                              │
│  Step 3: 구현 옵션 도출                                      │
│          • 2-3개 접근 방식 제시                               │
│          • 각각 장단점 + 코드 레벨 변경사항                   │
│                                                              │
│  Step 4: session_links 업데이트 (내부)                        │
│          { "type": "session_links",                          │
│            "issue": "Jira URL", "pr": "(있으면)" }           │
│                                                              │
│  Step 5: UIAskUserQuestion — 다음 단계 선택                  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ [plan]   Implementation Spec 작성 (권장)             │    │
│  │          → CONTINUE_SESSION → jira-planning          │    │
│  │                                                      │    │
│  │ [fix]    바로 구현 시작                               │    │
│  │          → CONTINUE_SESSION → jira-create-pr         │    │
│  │                                                      │    │
│  │ [close]  여기서 종료                                  │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 유저가 "바로 구현" 선택시 → jira-create-pr 워크플로우

**프롬프트**: `src/prompt/workflows/jira-create-pr.prompt` + `common.prompt`

```
┌──────────────────────────────────────────────────────────────┐
│ StreamExecutor + jira-create-pr.prompt                        │
│                                                              │
│  전제: Jira 이슈에 Implementation Spec이 있어야 함           │
│        (없으면 jira-planning 먼저 진행하라고 안내)            │
│                                                              │
│  ┌── RED Phase (스캐폴드) ──────────────────────────────┐    │
│  │ • 실패하는 테스트 먼저 작성                           │    │
│  │ • 최소 구현 뼈대 추가 (테스트는 여전히 실패)          │    │
│  │ • git checkout -b feature/PTN-123-short-desc          │    │
│  │ • git commit + git push -u origin                     │    │
│  │ • Draft PR 생성 (gh pr create)                        │    │
│  │ • session_links 업데이트 (jira + pr)                  │    │
│  └──────────────────────────┬────────────────────────────┘    │
│                             │                                │
│                             ▼                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ UIAskUserQuestion:                                   │    │
│  │ "Red phase 완료. Green phase로 계속할까요?"           │    │
│  │ [Green 진행] [여기서 중단]                            │    │
│  └───────────┬──────────────────────┬───────────────────┘    │
│     Green 진행│                     │ 중단 → Draft PR로 종료 │
│              ▼                                               │
│  ┌── GREEN Phase (구현 완료) ───────────────────────────┐    │
│  │ • 실제 로직 구현                                     │    │
│  │ • 실패 테스트 모두 통과시키기                         │    │
│  │ • npm test + npm run build 확인                       │    │
│  │ • git commit + git push                               │    │
│  └──────────────────────────┬────────────────────────────┘    │
│                             │                                │
│                             ▼                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ UIAskUserQuestion:                                   │    │
│  │ "Green phase 완료. Refactor phase까지 진행할까요?"    │    │
│  │ [Refactor 진행] [여기서 중단]                         │    │
│  └───────────┬──────────────────────┬───────────────────┘    │
│     Refactor │                      │ 중단 → 구현 완료 상태  │
│              ▼                                               │
│  ┌── REFACTOR Phase (정리) ─────────────────────────────┐    │
│  │ • 중복 제거, 네이밍 개선, 구조 정리                   │    │
│  │ • 테스트 재실행                                      │    │
│  │ • PR 본문 → "Ready for review" 상태로 갱신            │    │
│  │ • git commit + git push                               │    │
│  └──────────────────────────┬────────────────────────────┘    │
│                             │                                │
│                             ▼                                │
│  "리뷰를 받으려면 새 세션에서 PR 링크를 입력하세요"          │
│  → 유저가 PR 링크로 새 세션 시작 → 워크플로우 1 진입         │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. PR 픽스 워크플로우

**트리거**: `@제갈량 fix {pr_link}`
**디스패치**: `dispatch.prompt` → pattern #4 ("fix" + GitHub PR) → `pr-fix-and-update`
**프롬프트**: `src/prompt/workflows/pr-fix-and-update.prompt` + `common.prompt`

```
 User: "@제갈량 fix https://github.com/org/repo/pull/42"
 │
 ▼
┌──────────────────────────────────────────────────────────────┐
│ Dispatch (Haiku 4.5)                                         │
│ → { "workflow": "pr-fix-and-update", "title": "PR #42 Fix", │
│     "links": { "pr": "https://...pull/42" } }               │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ StreamExecutor + pr-fix-and-update.prompt                     │
│                                                              │
│  Step 1: /github-pr 스킬로 PR 데이터 수집                   │
│          (리뷰, 코멘트, 변경 파일, 메타데이터)                │
│                                                              │
│  Step 2: git clone → PR 브랜치 checkout                      │
│          $WORKING_DIR/{timestamp}_repo_pr_42/                │
│                                                              │
│  Step 3: 피드백 수집 & 필터링                                │
│          • resolved된 댓글은 무시                             │
│          • 이미 해결된 문제 → 자동 resolve + 댓글             │
│          (해결된 건수만 요약, 내용은 언급 안함)               │
│                                                              │
│  Step 4: 남은 피드백 분류 — Priority × Switching Cost         │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ # │ 파일      │ 라인│ 피드백     │ P  │ Tier   │~줄│    │
│  │ 1 │ file.ts   │ 42  │ null체크   │ P1 │ medium │~50│    │
│  │ 2 │ other.ts  │ 15  │ 오타       │ P2 │ tiny   │ ~5│    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Step 5: Decision Gate                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ tiny/small (< ~20줄):                                │    │
│  │   → 3명 다수결 자율 수정                              │    │
│  │   → oracle-reviewer + oracle-gemini-reviewer 병렬     │    │
│  │   → 수정 후 PR conversation에 커멘트 + resolve        │    │
│  │                                                      │    │
│  │ medium+ (>= ~50줄):                                  │    │
│  │   → UIAskUserQuestion (한번에 모든 medium+ 묶어서)    │    │
│  │   → 각 이슈별 선택지:                                │    │
│  │     [Fix in this PR] [Defer to followup] [Skip]      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Step 6: 코드 수정 실행                                      │
│          • 자율 수정 건 (이미 완료) + 유저 결정 건 합산       │
│          • 파일 수정 → 테스트 수정 → npm test + npm build     │
│                                                              │
│  Step 7: 코드 정리 (rebase + code-simplify)                  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ git fetch origin && git rebase origin/main            │    │
│  │ → conflict 발생시 해결 (불가능하면 abort + 유저 질문) │    │
│  │ → code-simplify agent 실행 (origin/main...HEAD diff)  │    │
│  │ → 결과 반영 → 테스트 재실행 → commit                  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Step 8: git push                                            │
│                                                              │
│  Step 9: 자동 워크플로우 전환 (push 성공시)                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ CONTINUE_SESSION → pr-review                         │    │
│  │ { "commandId": "CONTINUE_SESSION",                   │    │
│  │   "params": {                                        │    │
│  │     "prompt": "new <PR_URL>",                        │    │
│  │     "resetSession": true,                            │    │
│  │     "forceWorkflow": "pr-review"                     │    │
│  │   }                                                  │    │
│  │ }                                                    │    │
│  │                                                      │    │
│  │ ※ test/build 실패 또는 push 실패시 전환 안함          │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 워크플로우 전체 관계 & 재귀 루프

```
                         Slack Channel (repo 연결)
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                    ▼             ▼             ▼
              ┌──────────┐ ┌──────────┐ ┌──────────────┐
              │ {pr_url}  │ │ {issue}  │ │ fix {pr_url} │
              └─────┬─────┘ └────┬─────┘ └──────┬───────┘
                    │            │              │
         Haiku 4.5 │  Haiku 4.5 │    Haiku 4.5 │
          dispatch  │  dispatch  │    dispatch   │
                    │            │              │
                    ▼            ▼              ▼
              ┌──────────┐ ┌──────────┐ ┌──────────────────┐
              │pr-review │ │jira-     │ │pr-fix-and-update │
              │.prompt   │ │brainstorm│ │.prompt           │
              └────┬─────┘ │.prompt   │ └────────┬─────────┘
                   │       └────┬─────┘          │
                   │            │                │
                   │            ▼                │
                   │  ┌───────────────────┐      │
                   │  │ UIAskUserQuestion │      │
                   │  │ plan/fix/close    │      │
                   │  └──┬──────────┬─────┘      │
                   │     │          │             │
                   │     ▼          ▼             │
                   │  jira-plan  jira-create-pr   │
                   │  .prompt    .prompt          │
                   │               │              │
                   │     Red→Green→Refactor       │
                   │               │              │
                   │          PR 생성              │
                   │               │              │
                   │      ┌────────┘              │
                   │      │                       │
                   ▼      ▼                       │
              ┌──────────────┐                    │
              │   pr-review  │ ◄──────────────────┘
              │              │    CONTINUE_SESSION
              │  리뷰 실행   │    (push 성공 후 자동)
              │              │
              │  ┌────────┐  │
              │  │ fix?   │  │
              │  └───┬────┘  │
              │  Yes │       │
              │      ▼       │
              │ CONTINUE     │
              │ _SESSION ────┼──→ pr-fix-and-update
              │              │         │
              │  ◄───────────┼─────────┘
              │  (재리뷰)    │    CONTINUE_SESSION
              └──────────────┘
                   │
                   ▼
            ┌────────────┐
            │ Merge Gate │  (P0/P1 없음 + CI 성공 + Approve)
            │            │
            │ [merge_now]│ → PR 머지
            │ [rerun]    │ → CONTINUE_SESSION → pr-review
            │ [wait]     │ → 종료
            └────────────┘
```

---

## 핵심 파일 참조

| 파일 | 역할 |
|------|------|
| `src/prompt/dispatch.prompt` | 워크플로우 분류 규칙 (Haiku에게 전달) |
| `src/prompt/common.prompt` | 모든 워크플로우 공통 베이스 프롬프트 |
| `src/prompt/workflows/pr-review.prompt` | PR 리뷰 워크플로우 상세 지시 |
| `src/prompt/workflows/pr-fix-and-update.prompt` | PR 수정 워크플로우 상세 지시 |
| `src/prompt/workflows/jira-brainstorming.prompt` | 이슈 분석 워크플로우 |
| `src/prompt/workflows/jira-create-pr.prompt` | TDD 기반 구현 워크플로우 (Red→Green→Refactor) |
| `src/prompt/workflows/jira-planning.prompt` | Implementation Spec 작성 워크플로우 |
| `src/dispatch-service.ts` | 디스패치 서비스 (Haiku 호출 + JSON 파싱) |
| `src/prompt-builder.ts` | 시스템 프롬프트 조립 (include + variable + persona) |
| `src/slack/pipeline/input-processor.ts` | 입력 전처리 (파일 + 커맨드) |
| `src/slack/pipeline/session-initializer.ts` | 세션 생성 + 디스패치 트리거 + 채널 라우팅 |
| `src/slack/pipeline/stream-executor.ts` | Claude SDK 실행 + 스트리밍 응답 처리 |
| `src/claude-handler.ts` | Claude Code SDK 인터페이스 |
