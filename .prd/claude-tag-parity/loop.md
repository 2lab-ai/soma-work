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
| G1 | 시각화 업로드 | 닫힘 2026-10-20 — PNG `F0CANQ1GTBK` + HTML `F0CAJUBEVM4` Slack 스레드 업로드, live `http://192.168.0.18:8763/html-claude-tag-gap-20261020-182448.html` (HTTP 200 확인) |
| G2 | 유저 확정 (범위·구조·PR 여부) | 질문 게시 2026-10-20 (범위: 33개 전부 / P0–P2 / P0–P1 / 직접 지정 · 구조: 에픽 1 / 묶음 에픽 6 / 평면 · `.prd` PR 여부), 답 대기 |
| G3 | 확정 피처 이슈 생성 | 열림 |
| G4 | 스펙 §3 이슈 번호 반영 | 열림 |

## 다음 착수점

- G2 답 대기 (2026-10-20 09:28Z 질문, 10:53Z·21:44Z 재게시, 2026-10-21 08:08Z 텍스트 답 안내; 2026-10-21 08:11Z 기준 답 없음). 유저 확정 전에는 이슈를 만들지 않는다.
- 답이 오면 G3: 스펙 §3 표 한 행 = 이슈 하나. 제목 `[Claude Tag parity] F-xx <피처>`, 본문 = 스펙 §4 해당 절 + CT 근거 링크(대조표 출처 열) + 의존 이슈 번호 + 공통 이음매(§5). 라벨 = `feature` + 우선순위(`P0`–`P3`) + 묶음 영역(A `security` · B·D `slack` · C `agent-architecture` · E `interop` · F `observability`) + 크기 L·XL·F-02는 `idea`, 나머지는 `ready-to-agent`. 에픽을 고르면 에픽 이슈를 먼저 만들고 피처 이슈를 sub-issue로 연결한다.
- G4: 스펙 §3 표에 이슈 열을 추가하고 이 브랜치에 커밋한다. G2에서 PR을 고르면 그 뒤 main으로 PR을 연다 (2026-10-20 첫 PR 생성 시도는 유저 승인 거절로 보류됨).
