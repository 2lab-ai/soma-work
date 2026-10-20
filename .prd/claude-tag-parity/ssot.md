# SSOT — Claude Tag 대비 갭 정리와 피처별 이슈화

Status: in-progress · 작성 2026-10-20 · 기준 커밋 main `5dfb235`

## 유저 원문 (verbatim, 2026-10-20 Slack 멘션)

> claude tag에 대한 기능을 리서치해주고 soma-work에 없는 피쳐들을 using-dotprd 스킬을이용하여 정리해주고 피쳐리스트에 대해서 시각화해줘 거기에서 컨펌을 받아서 각각의 피쳐에 대해서 별도로 작업 진행할수 있도록 깃허브 이슈에 각각 추가해줘

## 요건 분해 (SSOT-TASK-TREE의 ssot-task)

| ID | 원문 구절 | 산출물 |
|---|---|---|
| T1 | "claude tag에 대한 기능을 리서치해주고" | Claude Tag 기능 카탈로그 103개 (`../research/claude-tag-catalog.md`) |
| T2 | "soma-work에 없는 피쳐들을 using-dotprd 스킬을이용하여 정리해주고" | `../11-claude-tag-parity-spec.md` (피처 33개) + 이 폴더의 `ssot.md`·`loop.md` |
| T3 | "피쳐리스트에 대해서 시각화해줘" | 피처 트리 HTML + PNG (Slack 스레드 업로드) |
| T4 | "거기에서 컨펌을 받아서" | 유저 선택 기록 (`loop.md` R1) |
| T5 | "각각의 피쳐에 대해서 별도로 작업 진행할수 있도록 깃허브 이슈에 각각 추가해줘" | 확정 피처마다 GitHub 이슈 1개, 스펙 §3 표에 이슈 번호 |

의존: T2 ← T1, T3 ← T2, T4 ← T3, T5 ← T4.

## 확정 스코프

1. 리서치 대상은 Anthropic Claude Tag (2026-06-23 출시, Slack용 @Claude, legacy "Claude in Slack" 대체)다. 1차 출처는 공식 문서·발표·Claude Code changelog의 `[Claude Tag]` 항목이다.
2. "soma-work에 없는 피쳐" = 대조표에서 `없음`과 `부분` 판정을 받은 기능. `부분`은 Claude Tag와 같은 사용자 결과가 나오지 않으므로 갭으로 센다.
3. Anthropic 호스팅·요금제 고유 기능은 갭이 아니다 (`해당없음`). 근거 표에 이유와 함께 남긴다.
4. 이슈는 피처 하나에 하나다. 유저가 확정한 피처만 만든다.
5. 이번 범위는 정리·시각화·이슈 생성까지다. 피처 구현은 각 이슈에서 따로 착수한다.

## 비목표

- 피처 구현, 아키텍처 확정, 배포.
- Claude Tag 브랜드·소스 복제.

## 스킬 출처

`using-dotprd`는 런타임 레지스트리에 설치돼 있지 않다. 원본 `2lab-ai/zbrain` `.claude/skills/using-dotprd/SKILL.md`를 2026-10-20 GitHub API로 직접 읽어 적용했다 (불변량: repo-root·git-tracked `.prd/`, 번호 문서 `Status:` 줄, 유저 원문 verbatim, 절대 날짜).
