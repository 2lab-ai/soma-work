# plugin-split — SSOT

Fixed target. User text verbatim; not to be reinterpreted during the loop.

## 2026-08-24 — goal

```
전체 이 하네스를 현재 상태를 기록하고 이걸 개선할것임

현재 상태:
(오픈소스) zworkflow: slack에 설치해서 업무용으로 쓰고 있는 soma-work가 사용하고 있는 플러그인이고 soma-work에서 제공하고 있는 툴들을 사용하고 있어서 외부로 떼어낼수 없는 스킬들이 있고 공용스킬도 혼합되어 있음
(오픈소스) stv: 예전에 작업한 플러그인인데 예전 개념이 많이 들어가있고 한번 개선하고 최소화해야함.
로컬 프로젝트: 실제 작업을 하면서 생성한 스킬들이 많음. 공개되면 안되는 내용들도 있고 최대한 공용 스킬은 리팩토링해서 외부로 빼야함.

목표:
1. 로컬은 모두 무시(내가 직접 삭제 예정), 로컬 프로젝트는 최소화한다. 로컬 프로젝트에 이는 스킬과 에이전트는 진짜 외부로 노출이 되면 안되는 내용들
2. soma-work/src/local 의 zworkflow 플러그인를 리팩토링한다.
2.a 폴더 변경. soma-work/zlocal, 이게 soma-work봇에서 local로 호출할수 있어야함.
2.b 플러그인 이름 변경. zworkflow -> zlocal
3. 공용 워크플로우를 soma-work repo에 만든다. 예: soma-work/zworkflow
3.a zlocal(구 zworkflow local)의 공용 스킬들을 추출한다. zlocal에서 삭제하고 zlocal에서 이걸 호출하도록 변경한다.
3.b stv의 에이전트와 스킬을 정제하고 zworkflow로 가져온다.
3.c local 프로젝트의 스킬과 에이전트에서 공용인 내용들을 추출해서 포팅하고 local 프로젝트에서 이 스킬들을 쓰도록 한다.
4. soma-work에서 현재 디폴트 플러그인이 구zworkflow였는데 변경된거 해주고 새 공용 워크플로우 zworkflow도 디폴트 플러그인 추가해서 설치해야함
```

## 2026-08-24 — naming correction (supersedes 2.a / 2.b / 3 names above)

```
AS-IS:
zworkflow@soma-work - 위치: soma-work/src/local, soma-work내에서 local

TO-BE:
zworkflow@local - 위치 soma-work/plugin/local, soma-work내에서 local
(신규)zworkflow@core - 위치 soma-work/plugin/core, soma-work내에서 core
```

## 2026-08-24 — membership rule (binding)

```
일단 병신아 잘 모르겠으면 local에 유지해야하는거야 병신아 스킬이랑 훅 모두 전수 조사해서 확인하고
디펜던시 그래프 그리고 단독으로 실행할수 있는 스킬과 단독으로 실행할수 있는 스킬과 에이전트를
쓰누느 것만 core로 옮겨야함
```

## 2026-09-14 — this folder

```
현재 지시 받은 내용을 /using-dotprd 이용하여 prd로 먼저 만들고 해당 prd를 시각화해줘
```

## Scope fixed from the above

- Names: plugin `local` at `plugin/local`, plugin `core` at `plugin/core`; install refs
  `local@soma-work`, `core@soma-work`; namespaces `local:`, `core:`.
- Classifier: census + closure (`03-migration-verdict.md`). Unknown ⇒ `local`.
- Out of scope: `~/.claude` (user deletes), z-family / trinity-family rewrites.
