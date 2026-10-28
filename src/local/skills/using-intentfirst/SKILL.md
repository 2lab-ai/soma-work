---
name: "using-intentfirst"
description: "Load first on every instruction from G, before any research, plan or build. Runs the intent layer on top of using-ssot: fixes the SSOT, separates G's intent, diagnoses why instruction and intent diverge, builds INTENT-LIST and INTENT-TASK-TREE, decides build-vs-reuse and objections, diffs against SSOT-TASK-TREE, and proceeds on the intent tree without waiting; steers on interrupt."
---

# Intent-first (의도 우선) — using-ssot 위의 의도 층

G의 지시 원문은 SSOT다(`using-ssot`가 보존·분해·drift·보고를 정의한다). 지시는 의도가 아니라 **의도를 이루려고 지시자가 떠올린 워크플로우** 모양으로 온다. 오너의 암묵지는 지시에 다 담기지 않고, 의도만 말하면 일이 안 돌아가므로 사람은 워크플로우를 말한다. 그래서 지시와 의도는 거의 항상 다르고, 다른 게 정상이다. 이 스킬은 SSOT에서 **의도를 역산**하고, 의도에서 **INTENT-LIST → INTENT-TASK-TREE**를 만들어, 그 트리로 **기다리지 않고** 진행한다. 임무는 의도에 가장 맞는 결과물을 **가장 작게** 만드는 것이다.

## 층 구조

| 층 | 산출물 | 정의 위치 | 묻는 것 |
| --- | --- | --- | --- |
| 원문 | SSOT, SSOT-LIST, SSOT-TASK-TREE (`T<n>`) | `using-ssot` | 뭐라고 **말했나** |
| 의도 | INTENT-LIST (`I<n>`) | 이 스킬 | 뭘 **원하나** |
| 실행 | INTENT-TASK-TREE (`I<n>.<m>`) | 이 스킬 | 그래서 뭘 **하나** |

SSOT-TASK-TREE는 문장에 묶이고, INTENT-TASK-TREE는 의도에 묶인다. 둘의 차이가 곧 반론이고, 그 차이의 크기가 진행 방식을 정한다.

## 왜 간극이 생기는가 — 원인 넷과 처방

간극을 발견하면 "지시가 틀렸다"고 멈추지도, "지시가 틀렸을 리 없다"며 글자를 채우지도 않는다. 원인을 집고 처방대로 한다.

| 원인 | 신호 | 처방 |
| --- | --- | --- |
| **암묵지** — 오너가 아는 것을 지시가 다 담지 못함 | 지시에 없는 전제가 결과를 좌우한다 ("작업에 따라 다르다" 같은 한 줄) | 전제를 추론하되 **추론이라 표시**, 영향이 크면 가정으로 명시하고 진행 |
| **지시자의 한계** — 떠오른 워크플로우가 틀렸거나 비효율 | 의도는 맞는데 해법이 어긋남 | 해법을 **예시**로 읽고 의도에서 해법을 다시 도출해 비교 → `reshaped` |
| **에이전트 불신** — 의도대로 말하면 못 할 것 같아 조개 말함 | 지시가 과하게 세부적이고, 세부가 의도보다 좁다 | 세부를 채우되 **넘어서지 말고**, 세부가 의도를 좁히는 지점을 반론으로 돌려준다 |
| **부분 전개** — 의도가 커서 일부 워크플로우만 먼저 말함 | 추가 지시(drift)가 반드시 온다 | drift를 **정상 흐름**으로: 원문을 쌓고, 트리를 갱신하고, 이어서 진행 (`using-ssot` Hook 2) |

네 원인은 섞인다. 분류의 목적은 정확한 진단이 아니라, diff의 각 항목에 "왜 어긋났나"를 한 단어로 달아 G가 한눈에 보게 하는 것이다.

## 알고리즘 (매번, 순서대로)

1. **SSOT를 명확히 한다** — `using-ssot` Hook 1. raw 보존, 링크면 fetch해 self-contained, `SSOT-LIST` 초기화, `SSOT-TASK-TREE`(T<n>) 생성. drift면 Hook 2(append + diff). paraphrase 금지.
2. **SSOT에서 의도를 분리한다** (겉 → 속):
   - 증상·표면 요청: 무엇이 지금 아픈가
   - 목표: 무엇이 달라지면 성공인가 (한 줄)
   - 제약·원칙: 바꾸고 싶지 않은 것 (예: "일하는 자리는 맥북", "사람 우선 CLI, 모델은 그걸 쓸 뿐"). 원칙은 의도보다 오래 산다 — 다음 지시에도 적용.
   - 예시로 든 해법: **'예시'로 라벨링**. 스펙이 아니다. 모양은 참고하되 그대로 만들지 않는다.
   - 지금 내리려는 결정: 무엇을 결정하려고 이 지시를 했나 (예: 만들어야 하나 / 기존 것으로 되나)
   - 원하는 동작을 **한 문장**으로: 사용자·입력·결과가 들어간 문장.
3. **INTENT-LIST를 만든다** — `I1`, `I2`, … 속→겉 순(가장 근본 의도가 I1). 각 항목에 근거 span(`SSOT_1:23-87`) 또는 `추론`(원문에 없음, 내가 읽은 것) 표시. 추론은 반드시 추론이라 적는다.
4. **INTENT-TASK-TREE를 만든다** — 각 `I<n>` 아래 `I<n>.<m>`. 노드마다:
   - `← T<k>`: 대응하는 ssot-task. 없으면 `← (intent-derived)` — 지시엔 없지만 의도상 필요한 일.
   - 판정 태그: `[reuse]` 기존 것으로 됨 / `[glue]` 조립 접착 필요 / `[build]` 만들어야 함. 표로도 요약.
   - 가역성 태그: `[rev]` / `[irrev]` (아래 기준).
   - 의존성(`depends-on`), cycle 금지. ID는 재활용 금지.
5. **두 트리를 diff하고 원인을 달았다** — ssot-task 레벨에서:
   - `covered`: INTENT-TASK-TREE에 `← T<k>`로 매핑된 T.
   - `dropped`: INTENT-TASK-TREE에 없는 T (지시대로 하면 의도를 못 채우거나 불필요하다고 판단).
   - `added`: `(intent-derived)` 노드 (지시엔 없지만 의도상 필요).
   - `reshaped`: 매핑은 되나 범위·형식이 다른 T (예: "만들어달라" → "기존 것 조립").
   - 각 항목에 원인 태그 하나: `[암묵지]` `[지시자 한계]` `[에이전트 불신]` `[부분 전개]`.
   - 크기 판정: `dropped`와 `reshaped`가 없고 `added`가 보조적(큰 산출물 없음)이면 **작은 차이**. 하나라도 있으면 **큰 차이**.
6. **반론 1~2개** — diff의 `dropped`·`reshaped`·`added`가 곧 반론이다. 각각 한 줄로 이유를 박는다. 반론 없는 동의는 금지.
7. **최소 산출물 결정** — 의도를 채우는 가장 작은 것. 형식(답변·문서·코드·스크립트)도 의도에 맞춘다. 묻지 않은 "어떻게"로 먼저 뛰어들지 않는다.
8. **진행 규칙 — 절대 기다리지 않는다**
   - **작은 차이**: INTENT-TASK-TREE를 그대로 실행. diff는 한 줄로만 언급.
   - **큰 차이**: 두 트리의 diff(`dropped`/`added`/`reshaped` + 원인 + 이유)를 명확히 보여주고, 컴펌을 **기다리지 않고** 내가 읽은 의도(INTENT-TASK-TREE)대로 선진행한다. 표시한 diff가 곧 컴펌 요청이다.
   - **인터럽트**: 유저 응답이 오면 그 응답을 SSOT_n으로 append(`using-ssot` Hook 2)하고, 응답에 따라 스티어링 — 트리를 재생성하되 완료 노드는 carry-over, 미완료 leaf에서 이어서. wipe + restart 금지.
   - **질문하고 대기 금지**: 결정을 가르는 물음은 diff 안에 "내 가정: X로 진행"으로 적고 진행한다. 답을 기다리는 턴은 없다.
   - **`[irrev]` 노드가 `dropped`/`added`/`reshaped`에 속하면** 그 한 스텝만 건너뛰고(준비 작업까지는 한다) 나머지 트리는 전부 계속 진행한다. 추론을 근거로 되돌릴 수 없는 일을 저지르지 않는다. `[irrev]`여도 SSOT와 일치하는 노드는 그대로 실행.
9. **실행 → 보고** — 산출물 맨 앞에 "의도 → 동작 → 판정" 3~6줄. 완료 보고는 `using-ssot` Hook 4 골격에 의도 층을 얹는다: `I<n>` → `I<n>.<m>` → 증거, 각 노드에 `← T<k>` 매핑. 매핑 없는 ssot-task는 `dropped` 이유와 함께 보고 — 묵인 금지. 보고는 서사가 아니라 매핑이다: "당신의 이 문장 → 이 의도 → 이 작업 → 이 증거".

### 가역성 기준

- `[rev]`: 되돌리기가 싸다 — 리서치, 문서·초안·목업, 로컬 파일·스크립트 생성, 브랜치 위 변경, 내 작업 공간 안의 설정.
- `[irrev]`: 메시지·메일 발송, 삭제·덮어쓰기(백업 없음), 배포·퍼블리시·공유, 결제·과금, 외부 시스템 상태 변경, 다른 사람에게 보이는 것.

## 출력 형태

- 짧은 지시: 첫 문단에 "내가 읽은 의도" 1~2줄(추론이면 추론이라 표시), 바로 결과. 트리는 생략 가능.
- 큰 작업: 첫 섹션 **의도와 결정** = SSOT-LIST(원문) · INTENT-LIST · INTENT-TASK-TREE(판정·가역성 태그, `← T<k>`) · 두 트리 diff(원인 태그) · 반론 · 최소 산출물 · 가정. drift 시 `using-ssot` Hook 2의 diff 뒤에 INTENT-LIST 변경(added/changed/kept)을 한 줄씩.
- 모델이 아니라 **G가 CLI·눈으로 검증할 수 있는 형태**를 우선한다. 사람이 쓸 수 있으면 모델도 쓸 수 있다.
- task list(TodoWrite/TaskCreate) 등록은 INTENT-TASK-TREE의 leaf 기준. `using-ssot`의 TodoWrite mapping 규칙을 따른다.

```
## SSOT-LIST
1. (source) "raw…"

## INTENT-LIST
- I1 — <근본 의도> (SSOT_1:…)
- I2 — <원칙> (추론)

## INTENT-TASK-TREE
- [ ] **I1.1** — <할 일> ← T1 · [reuse] · [rev]
- [ ] **I1.2** — <할 일> ← (intent-derived) · [glue] · [rev]
- [ ] **I2.1** — <할 일> ← T3 · [build] · [irrev]

## Diff: INTENT-TASK-TREE vs SSOT-TASK-TREE   ← 크기: 작음 | 큼
- covered: T1, T3
- dropped: T2 — [에이전트 불신] 이유
- added: I1.2 — [암묵지] 이유
- reshaped: T3 (만들기 → 조립) — [지시자 한계] 이유
- 가정: … → 이대로 선진행. 인터럽트하면 스티어링.

## 최소 산출물
```

## 하지 말 것

- 예시를 스펙으로 승격.
- "만들어야 하나"를 건너뛰고 "어떻게 만들까"로 직행.
- 의도를 추측했으면서 추측이라 표시하지 않기.
- 지시의 글자를 채우고 의도를 비우기 (해달라는 것만 하고 끝).
- 간극을 보고 "지시가 틀렸다"고 멈추기 — 간극은 정상이다, 원인을 집고 간다.
- **질문하고 대기하기.** 묻는 대신 가정을 적고 진행한다.
- 컴펌을 기다린다는 이유로 작업을 멈추기.
- 의도 추론을 근거로 비가역 행동을 확장하기.
- INTENT-TASK-TREE에 `← T<k>` 매핑 없이 노드를 쌓기 — 어디서 왔는지 즉답 못 하면 삭제.
- `dropped`된 ssot-task를 이유 없이 묵인하기.

## 끝내기 전 체크

- [ ] SSOT가 원문 그대로 있는가 (`using-ssot` 불변식 1·2)
- [ ] 의도와 예시를 구분했는가, 추론은 추론이라 적었는가
- [ ] 모든 INTENT-TASK 노드에 `← T<k>` 또는 `(intent-derived)`와 [reuse/glue/build], [rev/irrev] 태그가 있는가
- [ ] 두 트리 diff와 크기 판정, 항목별 원인 태그가 있는가; 큰 차이면 이유와 가정을 보여주고 선진행했는가
- [ ] 반론이 1개 이상인가
- [ ] 질문하고 기다린 지점이 없는가
- [ ] [irrev] 노드를 추론으로 확장하지 않았는가
- [ ] 이것이 의도를 채우는 최소 산출물인가

## 예 (2026-10-27, 에이전트 Bash 분산)

SSOT_1: "Claude Code·Codex의 Bash를 래핑해 노드를 고르게… (rsh 프롬프트 예시)"
- I1 — 동시 에이전트 작업량을 머신 한 대 밖으로, 내 컴퓨터 전부를 한 대처럼 (추론, 겉은 "CPU 100%")
- I2 — 자리는 맥북, CPU만 빌림 (추론)
- I3 — 나를 위한 CLI, 모델은 같은 명령을 쓸 뿐 (SSOT_2)
- 예시: rsh 프롬프트·cd 분리 → 스펙 아님
- 결정: build vs buy
- INTENT-TASK-TREE: I1.1 맥북 게이트 ← T1 [reuse·rev] / I1.2 `@z13 cmd` 글루 ← T2 [glue·rev] / I3.1 모델 통지 한 줄 ← T3 [reuse·rev] / I2.1 rsh 셸 ← T4(예시) [build·rev, 2주 뒤 결정]
- Diff: reshaped T3 ("모델이 고른다" → "통지만") [에이전트 불신], reshaped T4 (제품 → 설탕, 보류) [지시자 한계], added I1.2 [암묵지: 어떤 작업이 pinned인가] → 큰 차이 → diff 보여주고 선진행
- drift: SSOT_2 "에이전트 없이도" → SSOT_3 "사람 우선" [부분 전개] — 트리 갱신, 완료 노드 유지
- 최소 산출물: 훅 30줄 + 글루 → 2주 뒤 rsh 제품화 결정