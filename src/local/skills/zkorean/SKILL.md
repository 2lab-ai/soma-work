---
name: zkorean
description: AI(ChatGPT·Claude·Gemini 등)가 쓴 한글 텍스트를 "사람이 쓴 글처럼" 다듬는다. 번역투·영어 인용 과다·기계적 병렬·관용구·피동태 남용·접속사 남발·리듬 균일성·이모지/불릿 과다 등 10대 카테고리 40+ AI 티 패턴을 탐지·교정. 의미·수치·고유명사·직접 인용은 한 글자도 건드리지 않는다. 트리거 — "zkorean", "AI 티 없애줘", "AI 같은 글 자연스럽게", "GPT/ChatGPT 문체", "AI 번역투 고쳐", "사람이 쓴 것처럼 윤문", "한글 윤문", "AI 윤문", "ChatGPT 티 제거", "한글 자연스럽게", "번역투 제거", "humanize Korean", "naturalize Korean".
---

# zkorean — AI 한글 티 제거

> 출처: [`epoko77-ai/im-not-ai`](https://github.com/epoko77-ai/im-not-ai) v2.0 (MIT). 슬랙 봇 호출 경로에서 실제로 쓰는 부품만 남긴 슬림 포팅. 라이선스 원문은 `LICENSE.upstream`.

## 동작

`humanize-monolith` 에이전트 1개를 1회 호출. 그 안에서 탐지·윤문·자체검증을 한 번에 처리.

```
입력 텍스트
  ↓ [humanize-monolith — 단일 호출]
  ├ Read: references/quick-rules.md (룰북)
  └ Write: _workspace/{run_id}/final.md (윤문본 + 메타 주석)
```

## Phase 1 — 입력 저장

1. cwd 기준 `_workspace/{YYYY-MM-DD-NNN}/` 생성
   - `Glob(pattern="_workspace/YYYY-MM-DD-*/01_input.txt")`로 NNN 최댓값+1
   - 당일 폴더 없으면 NNN=001
2. 입력 텍스트를 `01_input.txt`로 저장
3. 첫 300자로 장르 자동 추정 (사용자 명시 시 우선)

## Phase 2 — Monolith 호출

`Agent` 도구로 `humanize-monolith` 1회 호출.

입력:
```
input_path: <abs>/_workspace/{run_id}/01_input.txt
quick_rules_path: <plugin>/skills/zkorean/references/quick-rules.md
genre_hint: 칼럼 | 리포트 | 블로그 | 공적 | null
```

출력:
- `_workspace/{run_id}/final.md` — 윤문본 본문 + 끝에 `<!-- HUMANIZE-SUMMARY -->` HTML 주석으로 메트릭·등급·자체검증 통합

## Phase 3 — 결과 전달

사용자에게 4가지 반환:
1. 한 줄 상태: `완료. 변경률 X% / 등급 Y / 자체검증 N/6 통과`
2. 윤문본 본문 (마크다운)
3. 핵심 카테고리 탐지 4~6건 (before → after)
4. 등급 B 이하면 잔존 finding 표기 (재실행은 사용자가 자연어로 요청)

## 옵션 (자연어로 같이)

- 장르: `칼럼` / `리포트` / `블로그` / `공적` (생략 시 자동 추정)
- 강도: `보수` / `기본` / `적극` (기본값: 기본)
- 최소심각도: `S1` / `S2` / `S3` (기본값: S2)

## 후속 명령

| 사용자 신호 | 처리 |
|---|---|
| "이 문단만 다시" | 해당 문단만 새 입력으로 새 run_id 생성 후 Phase 1부터 재실행 |
| "2차 윤문" | 기존 `final.md`를 새 입력으로 Phase 1부터 재실행 |
| "윤문 강도 조정" | `min_severity` 변경 후 재실행 |
| "장르 바꿔서" | `genre_hint` 변경 후 재실행 |

## 철칙

1. **의미 불변**: 사실·주장·수치·날짜·고유명사·직접 인용은 원문 100% 일치
2. **근거 기반**: `quick-rules.md`에 매핑되지 않는 구간은 안 건든다
3. **장르 유지**: 칼럼이 에세이로, 리포트가 블로그로 떨어지지 않게
4. **register 보존**: 격식체 입력 → 격식체 출력 (AI 티 = 문법·수사일 뿐)
5. **과윤문 금지**: 변경률 30%+ 경고, 50%+ 강제 중단·롤백
6. **Do-NOT list**: 고유명사·수치·인용·법조문·영어 약어(LLM·GPU·MCP·API 등) 원형 보존

## 정량 측정 (옵션, CLI 직접 실행)

`humanize-monolith`는 자체 휴리스틱으로 등급을 매기지만, 더 정밀한 post-editese 메트릭이 필요하면 정적 체커를 직접 실행.

```bash
python3 src/local/skills/zkorean/references/metrics_v2.py \
    --input _workspace/{run_id}/01_input.txt \
    --genre essay \
    --output _workspace/{run_id}/00_metrics_v2.json
```

`metrics.py`(v1.6) + `metrics_v2.py`(v2.0)는 표준 라이브러리만 사용. 측정 항목:
- **simplification**: lexical_diversity_ttr, lexical_density, ending_diversity
- **normalisation**: normalisation_score, da_streak_rate
- **interference (T1~T8)**: inanimate_subject_rate, by_passive_count, double_passive_count, pronoun_density, deul_overuse_rate, relative_clause_nesting, have_make_literal_count, double_particle_count, progressive_aspect_rate
- **composite**: interference_index (가중 합산)

장르별 베이스라인은 `references/baseline.json`, `references/baseline_v2.json`. 결과 JSON의 `risk_band` (low/mid/high) 로 위험도 분류.

## 참고 자료

- [`references/quick-rules.md`](references/quick-rules.md) — 룰북 (S1·S2 핵심 + 자체검증 6항)
- [`references/metrics.py`](references/metrics.py), [`references/metrics_v2.py`](references/metrics_v2.py) — 정적 체커
- [`references/baseline.json`](references/baseline.json), [`references/baseline_v2.json`](references/baseline_v2.json) — 장르별 베이스라인
- [`LICENSE.upstream`](LICENSE.upstream) — MIT (im-not-ai 원본)

## 비목표

- **AI 탐지기 우회 ✗** — 한글 글쓰기 품질 개선만이 목표
- **사실 수정 ✗** — 윤문이지 사실 검증 아님 (별도 작업)
- **어조 변경 ✗** — 격식↔반말 변환 안 함
