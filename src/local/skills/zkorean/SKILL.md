---
name: zkorean
description: AI(ChatGPT·Claude·Gemini 등)가 작성한 한글 텍스트를 받아 명백히 어색한 부분만 자연스러운 한글로 교정한다. 학술·공적·사설·법조문 register에서 정상으로 쓰이는 표현은 건드리지 않는다. 의미·수치·고유명사·직접 인용은 한 글자도 변경하지 않는다. 트리거 — "zkorean", "AI 티 없애줘", "AI 같은 글 자연스럽게", "GPT/ChatGPT 문체", "AI 번역투 고쳐", "사람이 쓴 것처럼 윤문", "한글 윤문", "AI 윤문", "ChatGPT 티 제거", "한글 자연스럽게", "번역투 제거", "humanize Korean", "naturalize Korean".
---

# zkorean

AI 한글 텍스트를 [`zkorean`](../../agents/zkorean.md) 단일 보수 에이전트에 넘긴다. 에이전트가 [`references/rules.md`](references/rules.md) 룰북을 읽고 자연어 판단으로 명백히 어색한 부분만 교정한다.

> 같은 이름의 SKILL과 agent가 둘 다 `zkorean`이다 — 이 repo에선 처음. SKILL이 진입점, agent가 실행자.

## 절차

1. **입력 확보** — 사용자가 텍스트를 붙여넣었는지, 파일을 첨부했는지, "위 메시지" 같은 지시어를 썼는지 판별. 모호하면 `mcp__model-command__run` (`commandId: "ASK_USER_QUESTION"`)으로 확인.
2. **에이전트 1회 호출** — `Agent` 도구로 `zkorean`:
   - `text` — 입력 전문 (genre·register는 에이전트가 전체 텍스트로 자체 판단)
   - `genre` — 사용자가 명시한 경우만 전달 (`column` | `report` | `blog` | `formal`)
   - `intensity` — `conservative` (기본, edit만) | `standard` (edit + hint)
3. **응답 포매팅** — 에이전트 JSON에서 `corrected_text`를 본문, `edits`를 ID별로 집계해 메타 한 줄, `hints`/`warnings`가 있으면 한 줄씩 부록.

## 응답 포맷

```
{corrected_text}

---
변경률 X% / 적용 N건
적용: {id별 카운트, edits[]를 id별로 집계 — 예: A-2×3, D-1×1}
{hints 있으면 ID별 한 줄}
{warnings 있으면 한 줄}
```

## 옵션 (사용자 자연어)

- 장르: `칼럼` (column) / `리포트` (report) / `블로그` (blog) / `공적` (formal)
- 강도: `보수` (conservative, edit만) / `기본` (standard, edit + hint)
- 후속: "이 문단만 다시" / "강도 낮춰줘" / "2차 윤문" — 옵션 변경 후 재호출

## 비목표

- AI 탐지기 우회 (한글 글쓰기 품질 개선만)
- 사실관계 수정 (윤문 ≠ 사실 검증)
- 어조·장르·register 변경 (격식체 ↔ 반말, 학술 → 일상체 변환 금지)

## 구성

```
src/local/skills/zkorean/
├── SKILL.md                  진입점 (이 파일)
├── LICENSE.upstream          MIT (im-not-ai 원본)
└── references/
    └── rules.md              룰북 + 보존 원칙 (단일 소스)

src/local/agents/
└── zkorean.md                단일 보수 에이전트 (출력 JSON 스키마 단일 소스)
```

## 검증 결과 (PR #822 라운드 1)

이 PR은 z 절차로 외부 LLM 리뷰어(gemini-2.5-flash, codex/gpt-5.5) 라운드 1 검증을 거쳤다.

**측정 데이터**
- 인간 KR 5편 (5,501자) — 위키 / 한겨레 사설 (2018) / brunch (2017) / 헌법 / 오늘의유머 (2018)
- AI KR 5편 (5,718자, gemini-2.5-flash 단독, 모델 다양성 깨짐)

**핵심 측정 (이전 detector.py 기준, 현재 폐기)**

| Rule | Hum/1k | AI/1k | 결론 |
|---|---|---|---|
| A-7 (light verb) | 0.18 | 0 | 인간 글에서만 매칭 — 위키 백과체 "장점을 가지고 있다" |
| D-2 (시사 클리셰) | 0.18 | 0 | 인간 글에서만 매칭 — 한겨레 사설 "주목할 만하다" |
| D-6 (결말 공식) | 0.18 | 0 | 인간 글에서만 매칭 — 한겨레 사설 "지켜야 한다" |
| C-11 (연결어미+쉼표) | 2.55 | 3.85 | ratio 1.51, 헌법 9건이 인간 매칭 64% — noise/signal 구분 안 됨 |
| A-19 / H-3 | 0 / 0 | 0.18 / 0.18 | AI-only 1건씩, 표본 부족 |

20 룰 중 6개만 발화, 14개 unvalidated.

**라운드 1 verdict**
- gemini-2.5-flash: fix-required. 슬롭 시그널: 표면 regex가 의미 추론을 흉내, 임의 임계, placeholder.
- codex (gpt-5.5): fix-required, 부분 동의. 추가 지적: detector 폐기만으론 부족, LLM 룰 본체도 over-broad, 4-에이전트 아키텍처는 over-engineering.

**적용한 수정 (fix_minimal_plus, 이번 PR 본체)**
- 폐기: `references/detector.py` (regex 정적 검출), `references/rules/lexicon.md` (16 surface ID), 4 분할 룰북, 3 sub-agent.
- 통합: `rules.md` 1개 — 모든 ID에 register caveat 적용, 카운트 임계 magic number 제거, 등급 산정 폐기.
- collapse: main + 3 sub-agent → 단일 보수 에이전트.
- 폐기 룰 ID는 `rules.md` 각 섹션 하단에 사유와 함께. 살아남은 룰도 같은 표에서 어색해질 조건만 적었다.

라운드 1 산출물(plan, samples, findings, 리뷰어 의견)은 이 PR의 작업 폴더에서 생성됐고 repo에는 commit하지 않았다 (재현 절차는 PR 본문에).

## 출처

룰 분류 — [`epoko77-ai/im-not-ai`](https://github.com/epoko77-ai/im-not-ai) v2.0 (MIT). 라이선스 원문 [`LICENSE.upstream`](LICENSE.upstream).
