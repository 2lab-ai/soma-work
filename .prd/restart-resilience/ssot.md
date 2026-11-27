# SSOT — restart-resilience (잠금 손상 · 재시도 표시 · 계정 풀 대기 · 본문 판별)

Status: planned · 작성 2026-11-25 · 기준 커밋 main `a9041b4d`
스펙 = [`../38-restart-resilience-spec.md`](../38-restart-resilience-spec.md) ·
아키텍처 = [`../39-restart-resilience-architecture.md`](../39-restart-resilience-architecture.md) · 드라이버 = [`loop.md`](loop.md) ·
에픽 https://github.com/2lab-ai/soma-work/issues/1434

공개 레포라 호스트 이름은 가렸다: ‹고객 dev 호스트›(고객 환경 dev2·stage0을 다루는 봇), ‹소유자 dev 호스트›(소유자 Mac의 dev 봇).

## SSOT-LIST (시간 순, append-only)

### SSOT_1 — 2026-11-25 11:04 KST, 대시보드 새 작업 (원문 그대로, 호스트 이름만 가림)

> 이거 ‹고객 dev 호스트›:dev 로그 확인해줘 어제 밤새 재시작 계속된 이유가 뭐야?

(첨부: 대시보드 대화 화면 캡처 — 2026-11-24 17:10 ~ 2026-11-25 07:57 KST "시스템 재시작 · 중단된 작업 자동 재개" 15줄.)

### SSOT_2 — 2026-11-25 16:09 KST, Slack (원문 그대로)

> $local:zfix

(진단에서 찾은 soma-work 기존 구현의 빈틈을 gap-spec으로 만들고 z 파이프라인으로 고치라는 지시.)

### SSOT_3 — 2026-11-25 16:53 KST, Slack (원문 그대로)

> $local:using-dotprd 로 dotprd를 만들고 그걸 설명하고 다시 나에게 작업 승인 계획 물어봐

## 확정 스코프

| T | 빈틈 | 이슈 | 판정(2026-11-25, main `a9041b4d`) |
|---|---|---|---|
| T1 | 저장소 잠금이 깨지면 봇 전체가 죽는다 | https://github.com/2lab-ai/soma-work/issues/1435 | ❌ 막힘 |
| T4 | 정상 답변 속 인용문이 계정 풀·사용량 거부로 오판된다 | https://github.com/2lab-ai/soma-work/issues/1436 | ❌ 막힘 |
| T2 | 오류 뒤 자동 재시도가 "서비스 재시작"으로 보인다 | https://github.com/2lab-ai/soma-work/issues/1437 | ❌ 막힘 |
| T3 | 목표 루프가 계정 풀이 알린 대기를 모른다 | https://github.com/2lab-ai/soma-work/issues/1438 | ⚠️ 부분 |

범위 밖: 호스트 운영(.NET 동시 빌드 제한) · 처리 안 된 예외 하나로 모든 하위 프로세스를 죽이는 방침 · Slack 소켓 워치독(설계대로
동작) · 정기 배포 시각 밖의 추가 배포(운영 확인) · 소진 뒤 저빈도 탐침(후속).

loop 중 이 스코프를 다시 해석하지 않는다. 바꾸려면 새 SSOT를 이 목록 끝에 붙인다.
