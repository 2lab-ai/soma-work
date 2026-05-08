---
name: zkorean
description: AI(ChatGPT·Claude·Gemini 등)가 작성한 한글 텍스트를 받아 AI 작문 패턴(번역투·관용구·기계 병렬·피동 남용·접속사 남발·리듬 균일성·이모지/불릿 과다 등)에 해당하는 부분만 자연스러운 한글로 교정한다. 의미·수치·고유명사·직접 인용은 한 글자도 건드리지 않는다. 트리거 — "zkorean", "AI 티 없애줘", "AI 같은 글 자연스럽게", "GPT/ChatGPT 문체", "AI 번역투 고쳐", "사람이 쓴 것처럼 윤문", "한글 윤문", "AI 윤문", "ChatGPT 티 제거", "한글 자연스럽게", "번역투 제거", "humanize Korean", "naturalize Korean".
---

# zkorean

AI 한글 텍스트를 받아 [`zkorean`](../../agents/zkorean.md) 메인 에이전트로 넘긴다. 메인이 detector(기계 검출) + 3개 서브 에이전트(자연어 판단)로 finding을 모아 텍스트에 적용하고 교정본을 반환한다.

## 절차

1. **입력 확보** — 사용자가 텍스트를 붙여넣었는지, 파일을 첨부했는지, "위 메시지" 같은 지시어를 썼는지 판별. 모호하면 `local:UIAskUserQuestion`으로 확인.
2. **장르 추정** — 첫 300자로 `column` / `report` / `blog` / `formal` 중 하나 추정. 사용자가 명시했으면 그것을 우선.
3. **메인 에이전트 호출** — `Agent` 도구로 `zkorean`을 1회 호출:
   - `text` — 입력 텍스트 전문
   - `genre` — 추정/명시 장르
   - `intensity` — `conservative` | `default` | `aggressive` (기본: default)
4. **응답 포매팅** — 메인이 반환한 JSON에서 `corrected_text`를 본문, 나머지를 메타 1줄로 묶어 사용자에게 반환.

## 응답 포맷

```
{corrected_text}

---
변경률 X% / 등급 Y / 자체검증 N/6 통과
적용: {id별 카운트, 예: A-2×3, D-2×1, C-11×4}
{잔존 finding 있으면 ID·이유 1줄}
```

## 옵션 (사용자 자연어)

- 장르: `칼럼` (column) / `리포트` (report) / `블로그` (blog) / `공적` (formal)
- 강도: `보수` (conservative, S1만) / `기본` (default, S1+S2) / `적극` (aggressive)
- 후속: "이 문단만 다시" / "번역투만 더 손봐줘" / "강도 낮춰줘" / "2차 윤문" — 옵션 변경 후 재호출

## 비목표

- AI 탐지기 우회 (한글 글쓰기 품질 개선만)
- 사실관계 수정 (윤문 ≠ 사실 검증)
- 어조·장르 변경 (격식체 ↔ 반말 변환 금지)

## 구성 요소

```
src/local/skills/zkorean/
├── SKILL.md                          (이 파일)
├── LICENSE.upstream                  (im-not-ai MIT)
└── references/
    ├── detector.py                   (regex 기반 표면형 룰 검출 + 교정 제안)
    └── rules/
        ├── shared.md                 (Do-NOT, 심각도, finding 스키마, 자체검증, 등급)
        ├── translationese.md         (A 자연어 룰)
        ├── structure.md              (C+E 자연어 룰)
        ├── modifiers.md              (F+I+B-2 자연어 룰)
        └── lexicon.md                (detector가 처리하는 표면형 룰)

src/local/agents/
├── zkorean.md                        (메인 — 오케스트레이터)
├── zkorean-translationese.md         (A 자연어)
├── zkorean-structure.md              (C+E 자연어)
└── zkorean-modifiers.md              (F+I+B-2 자연어)
```

## 출처

룰 분류는 [`epoko77-ai/im-not-ai`](https://github.com/epoko77-ai/im-not-ai) v2.0 (MIT)을 베이스로 한다. 라이선스 원문은 [`LICENSE.upstream`](LICENSE.upstream).
