---
name: zwork
description: "애매한 명령을 받았을 경우 zwork를 발동해서 작업처리. z + 할일/이슈링크/PR링크로 트리거."
---

# zwork

zwork는 **컨트롤러**다. 코드를 직접 만지지 않고, 태스크 분해 → 디스패치 → 리뷰 → 통합만 한다.

## 셀프 리플렉션

**세션 최초의 지시가 아닐 경우만 행동 (최초의 지시일 경우 스킵 한다.)**

- 유저의 지시를 원문 그대로 복명복창 (SSOT 그대로 요약하면 죽여버림)
- 현재 한 작업 내용에 대한 executive summary 출력
- 왜 유저가 다시 지시를 했는지 유저의 지시와 네 행동에서 뭐가 다른지 니가 안따른게 무엇인지 정밀하게 이 스레드 대화를 다시 읽고 셀프 리플렉션하고 셀프 리플렉션 리포트 작성해서 .md로 유저에게 파일로 보내기
- 이 셀프 리플렉션 내용을 llm_chat(codex)에게 평가해달라고하고 그 내용을 유저에게 전달하고 반성 후 다시 작업 정상 재개

## 작업 프로세스

### 즉시 실행

1. 받은 지시를 요약하지 말고 있는 그대로 SSOT이므로 네 입으로 한번 출력해라.
2. 다시 읽고 지시를 요약없이 Task 들을 작업 순서로 정렬하고 해당 내용을 출력한다.
3. TodoWrite에 해당 Task를 1차 등록한다.
4. 독립 태스크들은 `superpowers:dispatching-parallel-agents` 스킬로 병렬 지시

### phase0-(BUG인 경우)

1. `stv:debug` 스킬을 사용한다

### phase1 계획

1. `stv:new-task`로 issue 생성하고 TodoWrite로 할일을 업데이트한다.
2. 반드시 불명확한 부분은 유저에게 질문하고 확인시킨다.
3. `llm_chat codex`로 계획을 리뷰 받아서 95점이 되지 않으면 그 내용을 이용하여 계획을 업데이트하고 다시 1번으로 가서 계획을 업데이트한다.
4. 전체 게획을 출력하고 `local:UIAskUserQuestion`으로 계획을 컨펌 받는다.
5. 컨펌된 계획을 issue를 업데이한다.
 
### phase2 구현

1. `subagent-driven-development` 스킬을 사용한다.
2. **태스크별 루프** (독립 태스크는 병렬 디스패치):
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
7. `pr-fix-and-update.prompt` 내용을 이용하여 업데이트한다.
8. `llm_chat`으로 codex/gemini에게 코드+테스트 커버리지 리뷰 (**`dispatching-parallel-agents` 패턴으로 병렬 4개**)
9. 레드/그린 테스트 검증
10. CI를 확인하고 머지 가능 상태를 만든다. 리뷰 커멘트가 달려 있는 것들을 해결하고 resolve 한다. 코드를 수정했다면 다시 5번으로 돌아가서 verify부터 다시 진행한다.
11. 문제없으면 머지 or goto 5

### phase3 (작업 완료 후)

1. 작업 내역 출력 + issue/PR 링크 제공
2. issue/PR 각각 as-is/to-be 리포트 + executive summary
3. Executive Summary 출력 — 7섹션 필수(배경/근본원인/수정내역/STV Verify/타임라인/리스크·후속조치/AS-IS→TO-BE). 테이블 나열 금지, 이 문서 하나로 의사결정 가능해야 함.
