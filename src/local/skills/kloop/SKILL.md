---
name: kloop
description: "Karpathy Loop - 빠른 바이브 코딩 루프. prompt→code→run→error→re-prompt 사이클을 자동 반복하여 동작하는 코드를 만든다. /kloop [task] 또는 'karpathy loop', 'vibe coding loop', '빠르게 돌려봐'로 트리거."
argument-hint: "[--max-iter N] [--revert-threshold N] TASK_DESCRIPTION"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - Task
  - TaskOutput
  - TodoWrite
  - mcp__llm__chat
  - mcp__llm__chat-reply
---

# /kloop — Karpathy Vibe Coding Loop

Andrej Karpathy의 바이브 코딩 방법론을 자동화한 스킬.
**핵심: 생각하기 전에 돌려라. 에러가 곧 피드백이다.**

코드를 생성하고, 즉시 실행하고, 에러를 보고 고치는 사이클을 성공할 때까지 반복한다.
3회 연속 같은 에러면 접근 방식을 완전히 바꾼다. 5회 넘게 막히면 분해한다.

## Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `--max-iter` | 10 | 최대 반복 횟수 |
| `--revert-threshold` | 3 | 같은 에러 N회 반복 시 revert & rethink |

## The Loop

```
iter = 0
error_streak = 0
last_error = ""

while iter < max_iter:
    iter++

    1. GENERATE — 태스크 또는 에러 기반으로 코드 생성/수정
    2. RUN     — 즉시 실행 (build, test, run)
    3. OBSERVE — 결과 확인

    if SUCCESS:
        → DONE. 결과 출력 후 종료.

    if ERROR:
        current_error = 에러 메시지 캡처

        if current_error ≈ last_error:
            error_streak++
        else:
            error_streak = 1

        last_error = current_error

        if error_streak >= revert_threshold:
            → RETHINK: 현재 접근 폐기. git stash/revert.
            → 다른 전략으로 재시도.
            → error_streak = 0

        if iter >= max_iter / 2 AND no progress:
            → DECOMPOSE: 태스크를 더 작은 단위로 분해.
            → 각 단위를 개별 kloop으로 처리.

        → 에러 메시지를 컨텍스트에 추가하고 다음 GENERATE로.
```

## Phase 0 — Parse & Prepare

1. `$ARGUMENTS`에서 파라미터 파싱
2. 작업 디렉토리 확인 (git repo이면 현재 상태 기록)
3. 태스크를 한 줄로 요약하여 출력

```
[kloop] Task: {요약}
[kloop] Max iterations: {N}, Revert threshold: {M}
```

## Phase 1 — The Loop (핵심)

매 iteration마다:

### Step 1: GENERATE

- 첫 iteration이면 태스크 설명 기반으로 코드 생성
- 이후 iteration이면 에러 메시지 + 이전 시도 컨텍스트 기반으로 수정
- **코드를 과도하게 읽지 않는다** — 에러가 알려주는 것만 고친다

### Step 2: RUN

실행 가능한 명령을 자동 판단하여 실행:
- 빌드: `npm run build`, `cargo build`, `go build`, etc.
- 테스트: `npm test`, `cargo test`, `pytest`, etc.
- 직접 실행: 스크립트, 서버 기동 등

**타임아웃 60초.** 무한 루프 방지.

### Step 3: OBSERVE

```
if exit_code == 0 AND output looks correct:
    → SUCCESS
else:
    → 에러 메시지에서 핵심만 추출 (마지막 30줄)
    → 다음 GENERATE의 입력으로 전달
```

### RETHINK (error_streak >= threshold)

같은 벽에 3번 부딪혔다면 길이 틀린 것이다.

1. `git stash` 또는 변경 사항 백업
2. 에러 패턴 분석 — 왜 같은 에러가 반복되는가?
3. **완전히 다른 접근** 시도:
   - 다른 라이브러리
   - 다른 알고리즘
   - 다른 아키텍처
   - 문제를 더 작게 분해
4. 새 접근으로 GENERATE 재시작

### DECOMPOSE (절반 지점에서 진전 없음)

1. 현재 태스크를 2-3개 하위 태스크로 분해
2. 각 하위 태스크를 독립적으로 처리
3. 결과를 합산

## Phase 2 — Completion

성공 시 출력:

```markdown
## kloop Result

**Status**: SUCCESS (iteration {N}/{max})
**Task**: {원래 태스크}
**Changes**:
- {변경된 파일 목록}
**Iterations**:
1. {각 iteration 요약 — 무엇을 시도했고 결과는}
...
**Rethinks**: {횟수} (있었다면 어떤 전략 전환)
```

실패 시 출력:

```markdown
## kloop Result

**Status**: FAILED (max iterations reached)
**Task**: {원래 태스크}
**Last Error**: {마지막 에러}
**Attempts Summary**:
- {시도한 접근들 요약}
**Suggestion**: {다음에 시도할 만한 방향}
```

## Rules

1. **에러 메시지가 왕이다** — 추측하지 말고 에러가 말하는 것만 고쳐라
2. **작게, 자주** — 한 번에 많이 바꾸지 마라. 한 에러, 한 수정
3. **Revert는 패배가 아니다** — 막다른 길에서 돌아오는 것이 진짜 실력
4. **읽기 최소화** — 전체 코드를 이해하려 하지 마라. 돌아가게 만들어라
5. **타임박싱** — max_iter 넘으면 멈추고 상황 보고. 영원히 돌지 않는다
