# loop — Claude Tag 대비 갭 정리와 이슈화

Status: in-progress · 스펙 = [`../11-claude-tag-parity-spec.md`](../11-claude-tag-parity-spec.md) · SSOT = [`ssot.md`](ssot.md) · 근거 = [`../research/claude-tag-catalog.md`](../research/claude-tag-catalog.md)

## Build facts

- 문서 드라이브라 코드 게이트는 없다. 확인 명령:
  - 대조표 집계: `.prd/research/claude-tag-catalog.md`의 `| CT-` 행 103개, 판정 = 있음 16 · 부분 33 · 없음 35 · 해당없음 18 · 기존 트랙 1, 부분·없음 68개가 전부 피처 ID를 가진다.
  - 피처 수: 스펙 §3 표 33행 (P0 1 · P1 10 · P2 12 · P3 10).
- 이슈 생성: `gh issue create -R 2lab-ai/soma-work` (라벨 `feature` + 우선순위 `P0`–`P3` + 영역 라벨).

## R1 — 피처 목록 확정과 이슈 생성 (열림)

계획:
1. 피처 트리 시각화를 Slack 스레드에 올린다.
2. 유저에게 이슈로 만들 범위와 구조(에픽 유무)를 묻는다.
3. 확정된 피처마다 이슈를 만들고, 스펙 §3 표에 이슈 번호를 채운다.

열린 행:

| ID | 항목 | 상태 |
|---|---|---|
| G1 | 시각화 업로드 | 열림 |
| G2 | 유저 확정 (범위·구조) | 열림 |
| G3 | 확정 피처 이슈 생성 | 열림 |
| G4 | 스펙 §3 이슈 번호 반영 | 열림 |

## 다음 착수점

- G1부터. 유저 확정 전에는 이슈를 만들지 않는다.
