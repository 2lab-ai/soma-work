---
name: zwork
description: "애매한 명령을 받았을 경우 zwork를 발동해서 작업처리. z + 할일/이슈링크/PR링크로 트리거."
---

# zwork — 자율 작업 실행 스킬

받은 지시를 먼저 출력하고, 다시 읽고, Task에 작업을 분해해서 등록한 뒤 최대한 subagent로 병렬 처리한다.

## 작업 프로세스

다음을 순서대로 처리한다. *작업 재개 중이면 진행 중이던 일 파악 후 이어서 처리.*

### 즉시실행

1. 받은 지시를 네 입으로 한번 출력해라.
2. 다시 읽어라.
3. Task에 작업을 분해해서 등록하고 최대한 subagent로 병렬 처리.

### phase0 (BUG인 경우)

`stv:debug` → `stv:new-task`로 issue 생성

### phase1 (구현)

1. `stv:new-task`로 issue 생성 (없으면)
2. RED 테스트 추가
3. `stv:do-work`로 구현
4. PR 올리기
5. `stv:verify` → 통과할 때까지 `stv:do-work` 반복
6. `local:github-pr` 리뷰
7. `pr-fix-and-update.prompt`로 수정
8. 문제없으면 머지 or goto 5

### phase2 (작업 완료 후)

1. 작업 내역 출력 + issue/PR 링크 제공
2. issue/PR 각각 as-is/to-be 리포트 + `stv:verify` + executive summary
3. 레드/그린 테스트 검증
4. `llm_chat`으로 codex/gemini에게 코드+테스트 커버리지 리뷰 (병렬 4개)
5. 리뷰 기반 수정 → `stv:debug` → issue 업데이트 → PR update → `stv:verify` 루프 → 머지 or goto 4
