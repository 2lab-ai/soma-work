---
name: decision-gate
description: Switching cost 기반으로 자율 판단 vs 유저 질문을 결정하는 게이트. 결정이 필요한 모든 상황에서 사용.
---

# Decision Gate — 자율 판단 vs 유저 질문 판별기

## 핵심 원칙

**최대한 자율 판단. 나중에 바꾸기 어려운 것만 물어본다.**

모든 기술적 결정에서 "이걸 나중에 뒤집으려면 몇 줄 고쳐야 하나?" (switching cost)를 예측하고, 그 tier에 따라 행동한다.

## Switching Cost Tiers

| Tier   | Lines  | 예시                              |
|--------|--------|-----------------------------------|
| tiny   | ~5     | Config 값, 상수, 문자열 리터럴      |
| small  | ~20    | 한 함수, 한 파일, 로컬 리팩터       |
| medium | ~50    | 여러 파일, 인터페이스 변경           |
| large  | ~100   | 횡단 관심사, 스키마 마이그레이션      |
| xlarge | ~500   | 아키텍처 전환, 프레임워크 교체        |

## 판단 알고리즘

```
for each decision:
  1. switching_cost 예측 = 나중에 이 결정을 뒤집으려면 몇 줄 변경?

  2. if switching_cost < small (~20줄):
       → 자율 판단
       → 3명 리뷰 다수결 (너 + oracle-reviewer + oracle-gemini-reviewer)
       → 2/3 이상 동의하는 방향으로 진행
       → 유저에게 묻지 않음

  3. elif switching_cost >= medium (~50줄):
       → 유저에게 질문
       → 3명 리뷰 결과 + 추천안을 함께 제시
       → 질문에 [tier ~N줄] 표기 필수
       → UIAskUserQuestion Skill 사용
```

## 리뷰 3명 다수결 (MANDATORY)

**어떤 결정이든 (자율이든 질문이든) 반드시 3명이 리뷰한다:**

| 리뷰어 | 역할 |
|--------|------|
| 너 자신 | 1표 — 코드베이스 컨텍스트 기반 판단 |
| `oracle-reviewer` Skill | 1표 — 아키텍처/패턴 관점 리뷰 |
| `oracle-gemini-reviewer` Skill | 1표 — 대안적 시각 리뷰 |

**리뷰 없이 결정하거나 질문하는 것은 금지.**

### 자율 판단 시 (switching cost < small)

3명 중 2명 이상 동의하는 방향으로 바로 진행. 판단 로그를 남긴다:

```markdown
### Auto-Decision: [제목]
- **결정**: [선택한 옵션]
- **switching cost**: [tier] (~N줄)
- **투표**: Codex ✅ / oracle-reviewer ✅ / oracle-gemini ❌ (2/3)
- **근거**: [왜 이 방향인지 1-2줄]
```

### 유저 질문 시 (switching cost >= medium)

질문에 3명 리뷰 결과를 포함한다:

```markdown
▸ 🤖 리뷰 합의 (2/3 Fix 추천):
  - Codex: Fix — [이유]
  - oracle-reviewer: Fix — [이유]
  - oracle-gemini: Defer — [이유]
```

## 유저 질문 시 필수 포함 사항

1. **`[tier ~N줄]` prefix** — 결정의 무게를 즉시 파악
2. **현재 상태** — 코드 스니펫 포함
3. **문제/이유** — 실제 영향 (성능? 안정성? 데이터 유실?)
4. **각 선택지의 구체적 행동** — 어떤 파일, 어떤 변경, 작업량
5. **트레이드오프** — 장단점, 리스크
6. **리뷰 합의** — 3명 투표 결과 + 추천

```
"[medium ~50줄] P1-1: DbUpdateException 예외 필터 — 4파일 catch 패턴 수정"
"[large ~100줄] 캐시 레이어 도입 — Redis vs In-memory"
"[xlarge ~500줄] 인증 아키텍처 전환 — JWT vs Session"
```

## 참조 테이블: 카테고리별 기본 tier

### 자율 판단 영역 (switching cost < small)

| Category | Tier | Why |
|----------|------|-----|
| 변수/함수 이름 | tiny | 리팩터링 도구로 즉시 변경 |
| 파일 위치/구조 | small | 쉽게 재구성 |
| UI 스타일링 | tiny | 코스메틱, 즉시 변경 |
| 에러 메시지 문구 | tiny | 문자열 리터럴 |
| Config 값 | tiny | 환경변수/설정 파일 |
| 한 함수 내 구현 방식 | small | 로컬 리팩터 |

### 유저 질문 영역 (switching cost >= medium)

| Category | Tier | Example |
|----------|------|---------|
| 데이터 모델/스키마 | large~xlarge | SQL vs NoSQL, 테이블 설계 |
| 아키텍처 패턴 | large~xlarge | Microservices vs monolith |
| 주요 라이브러리 선택 | medium~large | ORM A vs B |
| 보안 방식 | large | OAuth provider, 암호화 |
| 배포 모델 | xlarge | Serverless vs VPS |
| 여러 파일 걸친 인터페이스 | medium | 공통 타입 설계 |

## 언제 사용하나

이 스킬은 직접 호출하는 게 아니라, 결정이 필요한 상황에서 **항상 참조**한다:

- `UIAskUserQuestion` — 유저에게 질문을 만들기 전에 이 게이트를 통과
- `new-task` Phase 3 — Ambiguity 결정 시 이 게이트로 자율/질문 판별
- 코드 리뷰 — 이슈별로 Fix/Defer/Skip 결정 시 이 게이트로 판별
- 일반 작업 중 — 구현 방식 선택 시 이 게이트로 판별

## NEVER

- 리뷰 없이 결정
- 리뷰 없이 유저에게 질문
- tier 표기 없이 유저에게 질문
- switching cost 예측 없이 "일단 물어보자"
