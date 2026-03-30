---
name: zwork
description: "애매한 명령을 받았을 경우 zwork를 발동해서 작업처리. z + 할일/이슈링크/PR링크로 트리거."
---

# zwork — 자율 작업 실행 스킬

받은 지시를 먼저 출력하고, 다시 읽고, Task에 작업을 분해해서 등록한 뒤 최대한 subagent로 병렬 처리한다.

## 에이전트 전략 (superpowers 통합)

zwork는 두 가지 superpowers 스킬을 상황에 맞게 사용한다:

### `superpowers:subagent-driven-development` — 구현 시 기본 전략
- 태스크별 **fresh subagent** 디스패치 (컨텍스트 오염 방지)
- 각 태스크 완료 후 **2단계 리뷰**: spec compliance → code quality
- implementer 상태(DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED) 핸들링
- 모델 선택: 단순 구현→haiku/sonnet, 통합 작업→sonnet, 설계/리뷰→opus

### `superpowers:dispatching-parallel-agents` — 독립 태스크 병렬 처리
- 3개 이상 독립적 태스크가 있으면 **동시 디스패치**
- 각 agent에 명확한 scope + constraint + 기대 output 지정
- 완료 후 충돌 검증 → 통합 테스트

### 언제 어떤 걸 쓰는가
| 상황 | 전략 |
|------|------|
| 태스크가 순차 의존성 있음 | subagent-driven (순차) |
| 3+ 독립 태스크 (다른 파일, 다른 서브시스템) | dispatching-parallel |
| 테스트 실패 3+ (서로 다른 원인) | dispatching-parallel |
| 혼합 (일부 독립, 일부 의존) | 독립 묶음은 병렬, 의존 체인은 순차 |

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

1. `stv:new-task`로 issue 생성 (없으면)
2. 플랜에서 모든 태스크 텍스트 + 컨텍스트 추출 (subagent가 파일 읽을 필요 없게)
3. **태스크별 루프** (독립 태스크는 병렬 디스패치):
   a. **Implementer subagent 디스패치** — 태스크 전체 텍스트 + 컨텍스트 + RED 테스트 포함
      - 질문 있으면 답변 후 재디스패치
      - 상태 핸들링: DONE→리뷰 진행, BLOCKED→컨텍스트 보강 or 모델 업그레이드, NEEDS_CONTEXT→정보 제공
   b. **Spec compliance reviewer subagent 디스패치** — 구현이 요구사항과 일치하는지 검증
      - ❌면 implementer가 수정 → 재리뷰
   c. **Code quality reviewer subagent 디스패치** — 코드 품질 검증 (spec 통과 후에만)
      - ❌면 implementer가 수정 → 재리뷰
   d. TodoWrite에서 태스크 완료 표시
4. PR 올리기
5. `stv:verify` → 통과할 때까지 반복
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
- 작업 디렉토리
- 컨텍스트 (아키텍처, 의존성, 이 태스크의 위치)
- TDD 요구 여부
- 자기 리뷰 후 보고 형식: Status / 구현 내용 / 테스트 결과 / 변경 파일 / 우려사항
```

### Parallel 디스패치 시 필수 포함 사항
```
- 각 agent에 명확한 scope (한 파일 or 한 서브시스템)
- 다른 agent의 코드 건드리지 말 것 (constraint)
- 기대 output 형식 명시
- 완료 후 반드시 통합 테스트 실행
```

## 금지사항
- main/master에서 직접 구현 시작 금지 (worktree 사용)
- spec compliance 리뷰 전에 code quality 리뷰 시작 금지
- 리뷰어가 이슈 발견했는데 재리뷰 없이 넘어가기 금지
- 여러 implementer를 같은 파일에 동시 디스패치 금지 (충돌)
- subagent 질문 무시 금지
