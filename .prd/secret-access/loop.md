# loop — secret-access 구현 드라이브

Status: done (2026-11-18) · ssot = [`ssot.md`](ssot.md) · 끝난 것 = [`loop.done.md`](loop.done.md) ·
스펙 = [`../32-secret-access-spec.md`](../32-secret-access-spec.md) (출하 기록 §8) · 아키텍처 = [`../33-secret-access-architecture.md`](../33-secret-access-architecture.md)

## 열린 질문

| ID | 질문 | Status | 기본값 (이대로 진행) |
|---|---|---|---|
| Q1 | 승인자가 어드민인가, 요청한 유저 자신인가 (SSOT_1 "유저별로 저장"의 읽기) | 🟡 | 어드민(32 D1). 비밀은 어드민 관리 대상이고 SSOT_2의 권한 편집도 어드민 |
| Q2 | 어드민 전용 도구를 비밀 허락으로 열어도 되나 | 🟡 | 연다(32 D6) — 도구 조건표는 유지, 카드에 경고. 막으려면 ③에서 어드민 전용 도구를 빼는 한 줄 |
| Q3 | 환경 × 도구 칸 권한이 필요한가 (SSOT_2 "각각의 api나 환경 등") | 🟡 | 도구별 · 환경별 따로(지금 권한 모델 두 축). 칸 권한은 새 SSOT |

## 게이트 (build facts)

33 §8.

## 다음 착수점

- #1347 — config.json을 읽는 나머지 리더(env-skill-registry · phone · mcp-tool-permission-config …)의 파싱 오류 로그에서 설정 텍스트 빼기.
- 비어드민 A1–A4 실측 — dev에 비어드민 계정과 안전한 비밀 서버가 생기면(Z 결정 `skip_live`로 이번엔 생략).
- #1170 — 권한 표가 없을 때 server-tools 닫기(서버 도구 탭은 경고 · "표 만들기"까지만).
