---
name: zkorean
description: AI(ChatGPT·Claude·Gemini 등)가 작성한 한글 텍스트를 받아 명백히 어색한 부분만 자연스러운 한글로 교정한다. 학술·공적·사설·법조문 register에서 정상으로 쓰이는 표현은 건드리지 않는다. 의미·수치·고유명사·직접 인용은 한 글자도 변경하지 않는다. 트리거 — "zkorean", "AI 티 없애줘", "AI 같은 글 자연스럽게", "GPT/ChatGPT 문체", "AI 번역투 고쳐", "사람이 쓴 것처럼 윤문", "한글 윤문", "AI 윤문", "ChatGPT 티 제거", "한글 자연스럽게", "번역투 제거", "humanize Korean", "naturalize Korean".
---

# zkorean

AI 한글 텍스트를 [`zkorean`](../../agents/zkorean.md) 단일 보수 에이전트에 넘긴다. 에이전트가 [`references/rules.md`](references/rules.md) 룰북을 읽고 자연어 판단으로 명백히 어색한 부분만 교정한다.

## 절차

1. **입력 확보** — 사용자가 텍스트를 붙여넣었는지, 파일을 첨부했는지, "위 메시지" 같은 지시어를 썼는지 판별. 모호하면 `local:UIAskUserQuestion`으로 확인.
2. **장르 추정** — 첫 300자로 `column` / `report` / `blog` / `formal` 중 하나. 사용자 명시가 우선.
3. **에이전트 호출** — `Agent` 도구로 `zkorean` 1회:
   - `text` — 입력 전문
   - `genre` — 추정/명시 장르
   - `intensity` — `conservative` (기본) / `default` / `aggressive`
   - `rules_path` — 절대 경로 `<plugin>/skills/zkorean/references/rules.md`
4. **응답 포매팅** — 에이전트가 반환한 JSON에서 `corrected_text`를 본문, 메타 1~2줄을 부록으로.

## 응답 포맷

```
{corrected_text}

---
변경률 X% / 적용 N건
적용: {id별 카운트, 예: A-2×3, D-1×1}
{hints 있으면 1줄 요약}
{warnings 있으면 1줄}
```

## 옵션 (사용자 자연어)

- 장르: `칼럼` / `리포트` / `블로그` / `공적`
- 강도: `보수` (기본, edit만) / `기본` (edit + hint 일부) / `적극` (edit + 모든 hint)
- 후속: "이 문단만 다시" / "강도 낮춰줘" / "2차 윤문" — 옵션 변경 후 재호출

## 비목표

- AI 탐지기 우회 (한글 글쓰기 품질 개선만)
- 사실관계 수정 (윤문 ≠ 사실 검증)
- 어조·장르 변경 (격식체 ↔ 반말 변환 금지)
- register 변경 (학술 → 일상체 변환 금지)

## 구성

```
src/local/skills/zkorean/
├── SKILL.md                      (이 파일)
├── LICENSE.upstream              (im-not-ai MIT)
└── references/
    └── rules.md                  (단일 룰북, register caveat 포함)

src/local/agents/
└── zkorean.md                    (단일 보수 에이전트)
```

## 검증 결과 (PR #822 라운드 1)

이 PR은 z 절차로 외부 LLM 리뷰어(gemini-2.5-flash, codex/gpt-5.5) 라운드 1 검증을 거쳤다. 결과:

**측정 데이터:**
- 인간 KR 5편 (5,501자) — 위키 / 한겨레 사설 (2018) / brunch (2017) / 헌법 / 오늘의유머 (2018)
- AI KR 5편 (5,718자, gemini-2.5-flash 단독, 모델 다양성 깨짐)

**측정 결과 (이전 detector.py 기준, 현재 폐기):**
- detector 룰 20개 중 6개만 발화, 14개 unvalidated
- A-7 / D-2 / D-6 BROKEN — 인간 글에서만 매칭 (위키 백과체, 사설 정형 표현)
- C-11 (연결어미 뒤 쉼표) ratio 1.51 — 헌법 9건이 14건 중 60% 차지, noise/signal 구분 안 됨

**라운드 1 verdict:**
- gemini-2.5-flash: score **20** / fix-required, slop axis hits 3개 (의미 측정 흉내 / placeholder / 임의 임계)
- codex (gpt-5.5): score **24** / fix-required, partial agreement with flash. 추가 지적: detector 폐기만으론 부족, LLM 룰 본체도 over-broad (A-1/A-2/A-3/A-10/E-2/I-4/F-4/F-5 등), main+3 sub-agent 아키텍처는 over-engineering

**적용한 수정 (fix_minimal_plus):**
- `references/detector.py` (559 lines, regex 정적 검출) **폐기**
- `references/rules/lexicon.md` (detector 룰 카탈로그 16 ID) **폐기**
- 4개 분할 룰북 (translationese/structure/modifiers/shared) → **단일 `rules.md` 통합**
- 메인 + 3 sub-agent 아키텍처 → **단일 보수 에이전트 collapse**
- BROKEN 룰 폐기: A-7, A-8, A-19, C-5, C-10, C-11, D-2, D-6, E-2, F-4, G-1, H-1, H-4, I-1, I-3, I-4, J-1, J-3
- 살아남은 룰 모두에 **register caveat** 추가 (학술·공적·사설·법조문에서 정상 표현은 통과)
- 카운트 임계 magic number 제거 — 자연어 판단만
- 등급 산정 폐기 — `edit` / `hint` 두 분류만

**현재 패키지 크기:** 1,103줄 → ~250줄 (78% 다이어트).

검증 산출물(plan / samples / findings / round 1 의견)은 PR 작업 폴더 (`/tmp/.../zkorean-validation/`)에 보존했다. 라운드 2 추가 검증은 사용자 결정에 따라 follow-up.

## 출처

룰 분류 체계는 [`epoko77-ai/im-not-ai`](https://github.com/epoko77-ai/im-not-ai) v2.0 (MIT)에서 가져왔다. 라이선스 원문 — [`LICENSE.upstream`](LICENSE.upstream).
