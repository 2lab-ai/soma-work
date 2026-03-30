# Workflow Network

이 문서는 soma-work의 워크플로우 네트워크 전체 구조를 설명한다.

## 전체 흐름도

```
┌─────────────────────────────────────────────────────────────────┐
│                        유저 입력                                 │
│  z + 할일/이슈/PR  │  Jira 보드  │  Jira 이슈  │  PR 링크  │ 배포 │
└────────┬───────────┬────────────┬────────────┬──────────┬──────┘
         │           │            │            │          │
         ▼           ▼            ▼            ▼          ▼
    ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐
    │  zwork  │ │executive │ │brainstorm│ │pr-review│ │ deploy │
    │(자율실행)│ │ summary  │ │ -ing     │ │         │ │        │
    └────┬────┘ └──────────┘ └────┬─────┘ └────┬────┘ └────────┘
         │                        │            │
         │                   ┌────▼─────┐      │
         │                   │ planning │      │
         │                   └────┬─────┘      │
         │                   ┌────▼─────┐      │
         │                   │create-pr │──────┤
         │                   └──────────┘      │
         │                                ┌────▼──────────┐
         └───────────────────────────────►│pr-fix-update  │
                                          └───┬───────────┘
                                              │ CONTINUE_SESSION
                                              ▼
                                         ┌─────────┐
                                         │pr-review│ (재귀)
                                         └─────────┘
```

## 워크플로우 목록

| 워크플로우 | 트리거 | 역할 |
|-----------|--------|------|
| `zwork` | `z` + 할일/이슈/PR | 자율 실행 오케스트레이터. stv:* 스킬 체인으로 이슈→구현→PR→머지 |
| `jira-executive-summary` | Jira 보드 링크 | 스프린트 현황 요약. In Progress/Todo/Done 분석 |
| `jira-brainstorming` | Jira 이슈 링크 | 이슈 분석 + 구현 옵션 도출. 코드베이스 탐색 포함 |
| `jira-planning` | Jira 이슈 + "plan" | Implementation Spec 작성 및 유저 승인 |
| `jira-create-pr` | Jira 이슈 + "fix"/"work" | Red→Green→Refactor로 PR 생성 |
| `pr-review` | GitHub PR 링크 | PR 리뷰. switching cost 분류 + 자율/유저 결정 분리 |
| `pr-fix-and-update` | PR + "fix" | 리뷰 피드백 반영. 자율 수정 + 유저 확인 |
| `deploy` | `repo source -> target` | 브랜치 배포. clone→PR→merge→릴리즈노트 |

## 핵심 흐름 3가지

### 1. Jira → 구현 흐름

```
jira-executive-summary → jira-brainstorming → jira-planning → jira-create-pr → pr-review
```

- executive-summary에서 이슈를 식별
- brainstorming에서 구현 방향 결정
- planning에서 Implementation Spec 확정
- create-pr에서 Red→Green→Refactor
- pr-review에서 리뷰 + 머지

### 2. PR 리뷰 루프

```
pr-review ⇄ pr-fix-and-update (CONTINUE_SESSION으로 양방향 재귀)
```

- pr-review에서 이슈 발견 → pr-fix-and-update로 전환
- fix 완료 후 자동으로 pr-review 재진입
- 이슈가 모두 해결될 때까지 반복
- merge gate 통과 시 머지

### 3. zwork 자율 실행

```
zwork → stv:new-task → stv:do-work → stv:verify → github-pr → pr-fix-update → pr-review
```

- zwork가 입력을 분석하여 적절한 stv 스킬 체인 실행
- 이슈 생성부터 PR 머지까지 자율 진행
- 각 단계에서 검증 실패 시 재시도

## 전환 메커니즘

워크플로우 간 전환은 3가지 방식으로 이루어진다.

### CONTINUE_SESSION (가장 강한 연결)

같은 스레드에서 워크플로우를 전환한다. 세션을 리셋하고 새 워크플로우를 강제 지정한다.

```json
{
  "commandId": "CONTINUE_SESSION",
  "params": {
    "prompt": "new <URL>",
    "resetSession": true,
    "dispatchText": "<URL>",
    "forceWorkflow": "<workflow-name>"
  }
}
```

사용하는 곳:
- `pr-review` → `pr-fix-and-update` (fix 필요 시)
- `pr-fix-and-update` → `pr-review` (fix 완료 후 재리뷰)
- `pr-review` → `pr-review` (rerun_review 선택 시)

### UIAskUserQuestion (유저 선택 기반 전환)

유저에게 다음 단계를 선택받아 전환한다. `local:UIAskUserQuestion` 스킬 사용.

사용하는 곳:
- `jira-brainstorming` → `jira-planning` 또는 `jira-create-pr`
- `pr-review` merge gate → merge/rerun/wait 선택

### 수동 안내 (가장 약한 연결)

"새 세션에서 ~를 입력하세요" 텍스트 안내. 흐름이 끊기므로 최소화해야 한다.

사용하는 곳:
- `jira-executive-summary` → 특정 이슈 분석
- `jira-planning` → PR 생성
- `jira-create-pr` → PR 리뷰

## 공통 인프라 (common.prompt)

모든 워크플로우가 `{{include:./common.prompt}}`로 공유하는 기반:

- **작업 폴더 규칙**: 유니크 폴더 생성 + git clone
- **용량 확인**: 512MB 이하면 fast_fail
- **model-command-tool 우선**: UIAskUserQuestion, 세션 링크 등은 MCP 우선
- **부하 모델(MCP)**: codex(최고 성능), gemini(준수)
- **세션 타이틀 자동 갱신**: 이슈 링크 시, PR 머지 시

## 주요 스킬 의존성

```
워크플로우 → 스킬 매핑:

zwork:
  - stv:new-task, stv:debug, stv:do-work, stv:verify
  - local:github-pr, local:decision-gate

pr-review:
  - local:review-pr (실행기)
  - local:oracle-reviewer, local:oracle-gemini-reviewer (3명 투표)
  - local:UIAskUserQuestion (유저 질문)
  - local:decision-gate (자율/유저 분류)

pr-fix-and-update:
  - local:github-pr (PR 데이터 수집)
  - local:oracle-reviewer, local:oracle-gemini-reviewer (수정 방향 투표)
  - code-simplifier (코드 정리)

jira-*:
  - mcp__jira__* (Jira API)
  - local:UIAskUserQuestion

deploy:
  - local:UIAskUserQuestion (배포 확인)
  - local:release-notes (릴리즈 노트 생성)
```

## 이슈 추적 흐름

PR 리뷰 워크플로우는 이슈 연결이 필수다:

1. PR body/branch/title에서 이슈 키 자동 추출
2. 추출 실패 시 유저에게 이슈 링크 요청
3. 이슈의 Acceptance Criteria를 리뷰 기준에 포함
4. 세션에 이슈 링크 자동 등록
