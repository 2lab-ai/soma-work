# Auth capacity overview SSOT

Status: implementation in progress
Source: Slack 1789551447.972329, 2026-09-16

## SSOT-LIST

### SSOT_1

```text
soma-work의 auth 커맨드 명령 개선해줘

지금은 클로드 코덱스 그록 순서 없이 나오는데

• claude 총 남은 량 ...
    ◦ ai1
    ◦ ai2
    ◦ ai3...
• codex 총 남은 량 ..
    ◦ ai1
    ◦ ai2
    ◦ ai3
• grok
    ◦ ...

대충 이런식으로 받은 내용을 가공해서 보여줘 그리고 언제 리셋되는지 최대한 한눈에 언제 토큰을 얼마나 사용할수 있는지 계획을 세울수 있도록 최대한 토큰 가용량을 쉽게 확인할 수 있도록 이 내용을 리서치해서 최대한 보여주도록 해줘

그리고 admin의 경우도 일반 유저처럼 출력해주는데 admin의 경우 추가 어드민 모드 버튼을 눌러서 변경 ui는 한번 더 눌러서 나오도록해줘
```

### SSOT_2

```text
$using-dotprd 스킬 사용해서 작업 진행
```

## SSOT-TASK-TREE

- T1: SSOT_1 provider list — Claude → Codex → Grok, provider totals followed by accounts
- T2: SSOT_1 paragraph beginning '대충' — research actual data; remaining capacity and reset planning without invented token balances
- T3: SSOT_1 final paragraph — same initial overview for admins; management controls require explicit admin-mode click
- T4: SSOT_2 — use using-dotprd

## Skill availability

Initial lookup: the Skill tool rejected `using-dotprd` and `local:using-dotprd`; MANAGE_SKILL get also returned not found. Installed paths and GitHub code search did not locate it.

Recovery on 2026-09-16: a direct repository-tree lookup found [the original using-dotprd skill in zbrain](https://github.com/2lab-ai/zbrain/blob/2fef422eb63070bc01f1b629faa1734a3b4a83a9/.claude/skills/using-dotprd/SKILL.md). Its full instructions and referenced `rules/DEV.md` were fetched, read and applied. The source is cached in the session evidence, not installed into the runtime registry. Do not claim that the earlier failed Skill invocation succeeded.

Application: preserve raw instructions here; promote the contract to numbered 06/07 documents; maintain work-unit ownership, gap matrix and observed receipts in loop/verification; keep `Status: in-progress` until merge, permitted preview deployment and post-deploy observation. Earlier work followed a manually derived `.prd` convention before the definition was found; that chronology is not rewritten.

## Artifacts

- [Spec and research](spec.md)
- [Execution and verification](verification.md)
