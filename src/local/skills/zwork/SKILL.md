---
name: zwork
description: "애매한 명령을 받았을 경우 zwork를 발동해서 작업처리. z + 할일/이슈링크/PR링크로 트리거."
---

# zwork — 자율 작업 실행 스킬

받은 지시를 먼저 출력하고, 다시 읽고, Task에 작업을 분해해서 등록한 뒤 최대한 subagent로 병렬 처리한다.

## 에이전트 전략 (superpowers 통합)

zwork는 **컨트롤러**다. 코드를 직접 만지지 않고, 태스크 분해 → 디스패치 → 리뷰 → 통합만 한다.

### `superpowers:subagent-driven-development` — 구현 시 기본 전략
- 태스크별 **fresh subagent** 디스패치 (컨텍스트 오염 방지)
- 각 태스크 완료 후 **2단계 리뷰**: spec compliance → code quality
- implementer 상태 핸들링:
  - **DONE** → spec compliance 리뷰 진행
  - **DONE_WITH_CONCERNS** → 우려사항 먼저 읽고, 정합성 문제면 해결 후 리뷰 / 관찰적 의견이면 메모하고 리뷰 진행
  - **NEEDS_CONTEXT** → 필요한 정보 제공 후 재디스패치
  - **BLOCKED** → (1) 컨텍스트 부족이면 보강 후 재디스패치, (2) 추론력 부족이면 상위 모델로 재디스패치, (3) 태스크 자체가 크면 분할, (4) 플랜 자체가 잘못됐으면 유저에게 에스컬레이션
- 모델 선택: 단순 구현(1~2파일, 명확한 spec)→haiku/sonnet, 통합 작업(다중 파일)→sonnet, 설계/리뷰→opus

### `superpowers:dispatching-parallel-agents` — 독립 태스크 병렬 처리
- **3개 이상** 독립적 태스크가 있으면 동시 디스패치
- **1~2개** 독립 태스크는 순차 처리 (병렬 오버헤드 > 이득)
- 각 agent에 명확한 scope + constraint + 기대 output 지정
- **공유 파일 주의**: 테스트 헬퍼, config, 공통 타입 파일을 여러 agent가 건드릴 수 있으면 순차로 전환
- 완료 후 **컨트롤러가** 충돌 검증 → 통합 테스트 실행 → 충돌 시 수동 해결

### 언제 어떤 걸 쓰는가
| 상황 | 전략 |
|------|------|
| 태스크가 순차 의존성 있음 | subagent-driven (순차) |
| 3+ 독립 태스크 (다른 파일, 다른 서브시스템) | dispatching-parallel |
| 테스트 실패 3+ (서로 다른 원인) | dispatching-parallel |
| 혼합 (일부 독립, 일부 의존) | 독립 묶음은 병렬, 의존 체인은 순차 |
| 1~2 독립 태스크 | 순차 (병렬 불필요) |

## 작업 프로세스

다음을 순서대로 처리한다. *작업 재개 중이면 진행 중이던 일 파악 후 이어서 처리.*

### 즉시실행

1. 받은 지시를 네 입으로 한번 출력해라.
2. 다시 읽어라.
3. TodoWrite에 작업을 분해해서 등록.
4. 독립 태스크 식별 → 가능한 것은 `superpowers:dispatching-parallel-agents` 패턴으로 병렬 디스패치.

### phase0 (BUG인 경우)

`stv:debug` → `stv:new-task`로 issue 생성

### phase1 (구현) — subagent-driven-development 적용

0. **Preflight**: `superpowers:using-git-worktrees`로 작업용 worktree 생성. main/master에서 직접 작업하지 않는다.
1. `stv:new-task`로 issue 생성 (없으면)
2. 플랜에서 모든 태스크 텍스트 + 컨텍스트 추출 (subagent가 파일 읽을 필요 없게)
3. **태스크별 루프** (독립 태스크는 병렬 디스패치):
   a. **Implementer subagent 디스패치** — 태스크 전체 텍스트 + 컨텍스트 + RED 테스트 포함
      - 질문 있으면 답변 후 재디스패치
      - 상태 핸들링: 위 "에이전트 전략" 섹션 참조
   b. **Spec compliance reviewer subagent 디스패치** — 구현이 요구사항과 일치하는지 검증
      - ❌면 implementer가 수정 → 재리뷰
   c. **Code quality reviewer subagent 디스패치** — 코드 품질 검증 (spec 통과 후에만)
      - ❌면 implementer가 수정 → 재리뷰
   d. TodoWrite에서 태스크 완료 표시
   - **루프 탈출**: 리뷰 재시도 3회 초과 시 `local:decision-gate`로 유저에게 판단 요청
4. PR 올리기
5. `stv:verify` → 통과할 때까지 반복 (최대 5회, 초과 시 `local:decision-gate`)
6. `local:github-pr` 최종 리뷰
7. `pr-fix-and-update.prompt`로 수정 (필요시)
8. 문제없으면 머지 or goto 5

### phase2 (작업 완료 후)

1. 작업 내역 출력 + issue/PR 링크 제공
2. issue/PR 각각 as-is/to-be 리포트 + `stv:verify` + executive summary
3. 레드/그린 테스트 검증
4. `llm_chat`으로 codex/gemini에게 코드+테스트 커버리지 리뷰 (**`dispatching-parallel-agents` 패턴으로 병렬 4개**)
5. 리뷰 기반 수정 → `stv:debug` → issue 업데이트 → PR update → `stv:verify` 루프 → 머지 or goto 4

## Subagent 프롬프트 가이드

### Implementer 디스패치 시 필수 포함 사항
```
- 태스크 전체 텍스트 (파일에서 읽게 하지 말 것)
- 작업 디렉토리 (worktree 경로)
- 작업 브랜치명
- 컨텍스트 (아키텍처, 의존성, 이 태스크의 위치)
- 수정 대상 파일 scope (이 파일들만 건드릴 것)
- TDD 요구 여부 및 테스트 실행 명령어
- Acceptance criteria (명확한 완료 조건)
- 자기 리뷰 후 보고 형식: Status / 구현 내용 / 테스트 결과 / 변경 파일 / 우려사항
```

### Spec Compliance Reviewer 디스패치 시 필수 포함 사항
```
- 원래 태스크 요구사항 전체 텍스트
- Implementer의 완료 보고서
- 주의: 보고서를 믿지 말고 반드시 코드를 직접 읽어서 검증할 것
- 판정 형식: ✅ Spec compliant / ❌ Issues found: [구체적 누락/초과 항목, file:line 참조]
```

### Code Quality Reviewer 디스패치 시 필수 포함 사항
```
- Implementer 보고서 요약
- 태스크 요구사항 (플랜 참조)
- BASE_SHA / HEAD_SHA (diff 범위)
- 판정 형식: Strengths / Issues (Critical/Important/Minor) / Assessment (Approved/Changes Required)
```

### Parallel 디스패치 시 필수 포함 사항
```
- 각 agent에 명확한 scope (한 파일 or 한 서브시스템)
- 다른 agent의 코드 건드리지 말 것 (constraint)
- 공유 파일(config, test helpers, types) 수정 금지 — 컨트롤러가 사후 처리
- 기대 output 형식 명시
- 완료 후 컨트롤러가 통합 테스트 실행
```

## 금지사항
- main/master에서 직접 구현 시작 금지 → `superpowers:using-git-worktrees`로 worktree 생성
- spec compliance 리뷰 전에 code quality 리뷰 시작 금지
- 리뷰어가 이슈 발견했는데 재리뷰 없이 넘어가기 금지
- 여러 implementer를 같은 파일에 동시 디스패치 금지 (충돌)
- subagent 질문 무시 금지
- 리뷰/verify 무한 루프 금지 → 3회(리뷰) / 5회(verify) 초과 시 `local:decision-gate`
