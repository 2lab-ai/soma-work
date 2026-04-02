---
name: es
description: "Trigger: when local:zwork completed."
---

# Executive Summary

작업 완료 후 이해관계자가 **이 문서 하나로 의사결정**할 수 있는 7섹션 구조의 요약 문서를 작성한다. (Slack markdownfmt + slack block kit을 이용하여 가독성 있게 작성)

## 작성 절차

1. `./reference/executive-summary-template.md`를 읽고 구조를 파악한다.
2. `./reference/executive-summary-example.md`를 읽고 톤과 깊이를 파악한다.
3. 현재 세션의 작업 내역(이슈, PR, 커밋, 리뷰)을 수집한다.
4. 템플릿 구조에 맞춰 Executive Summary를 작성한다.

## 7섹션 필수 구조

| # | 섹션 | 핵심 |
|---|------|------|
| 0 | SSOT | 유저의 원문 지시 + 이슈/PR 링크와 현재 상태 |
| 1 | 문제 배경 | Impact Chain + 비즈니스 영향 |
| 2 | 근본 원인 분석 | 장애 포인트 테이블 + 코드 결함 AS-IS/TO-BE |
| 3 | 수정 내역 | PR별 변경/파일/효과/리뷰 테이블 |
| 4 | STV Verify 결과 | Spec 항목별 검증 + Verdict |
| 5 | 타임라인 | UTC 시각별 이벤트 |
| 6 | 리스크 및 후속 조치 | 상태 아이콘(✅/⚠️/🔶) + 조치 |
| 7 | AS-IS → TO-BE 종합 | 항목별 이전/이후 비교 |

## 작성 규칙

- **테이블 나열 금지** — 각 섹션은 서사(narrative)로 연결되어야 한다.
- **모든 이슈/PR 링크 포함** — 각각의 현재 상태(Open/Merged/QA 등)를 명시한다.
- **유저 마찰 최소화** — 이 문서를 읽고 바로 다음 행동을 판단할 수 있어야 한다.
- SSOT 섹션의 유저 원문은 **절대 요약하지 않는다** — 그대로 인용한다.
