# loop — phone-calls 구현 드라이브

Status: in-progress · 라운드 1 · ssot = [`ssot.md`](ssot.md) · 스펙 = [`../30-phone-calls-spec.md`](../30-phone-calls-spec.md) ·
아키텍처 = [`../31-phone-calls-architecture.md`](../31-phone-calls-architecture.md)

## 라운드 1 — 걸고 받고, 카드로 보기

| ID | 작업 단위 | Status | 다음 |
|---|---|---|---|
| W1 | 음성 런타임: VAD · 문장 분할 · 음성 클라이언트 · 대화 모델(`query()`) · 음성 세션 · PhoneService(설정 30 s 동기화) | 🟡 | 단위 46 통과, 실서비스 하네스 통과(아래) — 실통화 실측(W5) 남음 |
| W2 | server-tools `phone_call` · `phone_calls` + 요청 파일 · 원격 셸 없는 환경 허용 | 🟡 | 단위 9 통과 — dev 배포 후 실측 |
| W3 | 대시보드: REST · WS · 카드 · 통화 보기 | 🟡 | 클라이언트 14 · 라우트 5 통과, 실제 클라이언트 코드 렌더 미리보기 확인 — dev 실화면 남음 |
| W4 | 로컬 dev 설정 `2lab-ai-dev` + 시크릿(사람 단계: SMS 인증 키 발급) | 🚪 | 사용자 작업 카드로 넘김 |
| W5 | 실측: 소유자 번호 발신(A2–A6), 070 수신(A7) | 🔴 | W1–W4 뒤 |

## 열린 gap

| ID | gap | Status | 다음 |
|---|---|---|---|
| G1 | 말 끝 → 첫 소리 지연 예상 5–7 s(TTS 첫 바이트 2.2–6.6 s 실측) — 전화에는 느리다 | 🟡 | 실측 후 음성 서비스 쪽 과제로 분리 |
| G2 | API 키 발급에 SMS 인증 필요 + 시크릿 저장소가 모델에 닫힘 → 사람 단계 | 🚪 | 사용자 작업 완료 대기(병행) |
| G3 | 번호 인바운드 라우팅이 대시보드 에이전트로 되어 있음 — SDK 연결이 우선하는지 실측 필요 | 🔴 | A7에서 확인 |

## 실측 (2026-11-17, 전화망 제외 하네스 — 실제 음성 서비스 + llmux)

- 3턴 가짜 통화: 첫 인사 → 상대 "여보세요?"(대화 모델로 보내지 않음) → 받아쓰기 정확(문장부호까지) → 확인 질문 → 끼어들기 2회 정지 → 작별 인사 후 `hang_up`.
- 말 끝 → 첫 응답 소리 5.24 s. 내역: VAD 0.7 · STT 0.95 · 첫 토큰 0.73 · 첫 문장 완성 ~0.3 · TTS 첫 바이트 2.2 (G1).
- 대화 모델 첫 턴 첫 토큰 1.6–3.5 s(CLI 기동 포함), 이후 0.59–0.73 s (claude-sonnet-5-5, llmux).

## build facts (실측)

- 클론 직후: `npm ci` → `npm run build:packages` → `npm run build:somalib`.
- `@koreaaitel/sdk` 0.62.3: CommonJS `require('@koreaaitel/sdk/agent')` 동작(Node 26). 하위 경로 타입은 `moduleResolution: node`가
  못 찾음 → `src/phone/koreaaitel.ts`의 좁은 인터페이스.
