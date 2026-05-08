"""zkorean static detector — surface-form rules only.

Generates finding JSON for rules whose detection and correction can be
decided by regex / lexicon counts alone. Does NOT call any LLM.

Covered rule IDs (defined in rules/lexicon.md):
- A-7  light-verb literal (가지고 있다 등)
- A-8  double passive (~되어진다)
- A-19 double particle (에서의·에로의 등)
- B-1  redundant English parens
- C-5  emoji
- C-9  numbered "(1)·(2)" indexing
- C-11 connective + comma
- D-1  conclusion-pivot lexicon
- D-2  cliché evaluation phrases (시사하는 바가 크다 …)
- D-3  본질적으로 / 핵심적으로
- D-4  hype lexicon
- D-6  closing formula (~할 때다 etc.)
- G-1  것이다 / 할 것이다 (5+)
- G-2  로 보인다 / 인 듯하다 (4+)
- G-3  safe-balance lexicon (4+)
- H-1  initial connectives (또한·따라서 …) 5+
- H-3  meta-entry (이는·이 점에서 …) 3+
- H-4  즉 (2+)
- I-1  ~인 것이다 / ~한 것이다 ending
- I-3  ~다는 뜻이다 / ~다는 의미다 ending
- J-2  quote emphasis (5+)
- J-3  bullet lists (genre-gated)

Usage:
    python3 detector.py --input text.txt --genre column --output findings.json
    python3 detector.py --input text.txt        # stdout JSON

Genre values: column (default) | report | blog | formal — affects only
genre-gated rules (C-5, J-3).

Returns JSON:
    {
      "char_count": int,
      "findings": [{id, severity, span, before, after, reason}, ...]
    }
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from typing import Iterable


# ---------------------------------------------------------------------------
# Finding type
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    id: str
    severity: str  # "S1" | "S2"
    span: str
    before: str
    after: str
    reason: str


# ---------------------------------------------------------------------------
# Lexicons
# ---------------------------------------------------------------------------

CONCLUSION_PIVOTS = ("결론적으로", "따라서", "이를 통해", "그러므로", "요약하면", "정리하면")
CLICHE_EVAL = ("시사하는 바가 크다", "시사하는 바가 작지 않다", "주목할 만하다", "주목할만하다")
ESSENCE_FILLER = ("본질적으로", "핵심적으로")
HYPE_WORDS = ("파격적", "압도적", "강력한", "획기적", "치명적", "혁신적인", "혁명적인")
CLOSING_FORMULA = ("할 때다", "해야 한다", "지금이야말로")
SAFE_BALANCE = ("양쪽 모두", "두 가지 모두", "장점도 있지만", "신중하게", "균형")
INITIAL_CONNECTIVES = ("또한", "따라서", "즉", "나아가", "아울러", "게다가", "더욱이")
META_ENTRY = ("이는", "이 점에서", "이 관점에서", "이 말은")

LIGHT_VERB_TOKENS = {
    "가지고 있다": "있다",
    "가지고있다": "있다",
    "갖고 있다": "있다",
    "갖고있다": "있다",
    "회의를 가졌다": "회의를 했다",
    "회의를 가지다": "회의를 하다",
    "결정을 내렸다": "결정했다",
    "결정을 내리다": "결정하다",
    "한번 봄을 가지다": "한번 보다",
}

DOUBLE_PASSIVE_TOKENS = {
    "되어진다": "된다",
    "되어졌다": "되었다",
    "되어진": "된",
    "되어지는": "되는",
    "여진다": "여진다",
    "잊혀진다": "잊힌다",
    "잊혀졌다": "잊혔다",
    "잊혀진": "잊힌",
    "보여진다": "보인다",
    "보여졌다": "보였다",
    "보여진": "보인",
    "쓰여진다": "쓰인다",
    "쓰여졌다": "쓰였다",
    "쓰여진": "쓰인",
    "닫혀진": "닫힌",
    "열려진": "열린",
    "불려진": "불린",
    "놓여진": "놓인",
}

DOUBLE_PARTICLES = ("에서의", "에로의", "으로의", "에의", "으로부터의", "로부터의")

CLOSING_INSANG_KOTIDA = ("인 것이다.", "한 것이다.", "는 것이다.", "이는 것이다.")
CLOSING_DAN_TTUTIDA = ("다는 뜻이다.", "다는 의미다.", "다는 의미이다.")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF]+"
)
NUMBERED_PAREN_RE = re.compile(r"\([1-9]\)")
CONNECTIVE_COMMA_RE = re.compile(r"([가-힣]+(?:고|며|지만|면서|아서|어서))\s*,")
# Conjunction adverbs that end with the same syllables but are NOT verb endings.
# These should never trigger C-11.
_C11_FALSE_POSITIVES = {
    "그리고", "그러나", "하지만", "또한", "그러므로", "따라서",
    "그래서", "그러면", "아무튼", "어쨌든", "한편", "반면",
}
KOR_PAREN_ENG_RE = re.compile(r"([가-힣]+)\(([A-Za-z][A-Za-z\s\-]{1,40})\)")
SENT_SPLIT_RE = re.compile(r"(?<=[\.!?])\s+")
WORD_BOUNDARY_RE = re.compile(r"(?<![가-힣A-Za-z0-9])({tok})(?![가-힣A-Za-z0-9])")
QUOTED_EMPHASIS_RE = re.compile(r"\"[^\"]{1,30}\"|“[^”]{1,30}”")
BULLET_LINE_RE = re.compile(r"^\s*[-*•]\s+", re.MULTILINE)


def _split_sentences(text: str) -> list[str]:
    return [s.strip() for s in SENT_SPLIT_RE.split(text.strip()) if s.strip()]


def _initial_connective_count(text: str, word: str) -> int:
    """Count occurrences of `word` as the first eojeol of a sentence."""
    cnt = 0
    for s in _split_sentences(text):
        first = s.split(maxsplit=1)[0] if s else ""
        # Strip punctuation off the first eojeol
        first = first.rstrip(",.!?")
        if first == word:
            cnt += 1
    return cnt


def _count_token(text: str, token: str) -> int:
    """Count token occurrences with rough word-boundary check."""
    return text.count(token)


# ---------------------------------------------------------------------------
# Per-rule detectors
# ---------------------------------------------------------------------------


def _detect_a7_light_verb(text: str) -> list[Finding]:
    out: list[Finding] = []
    for src, dst in LIGHT_VERB_TOKENS.items():
        if src in text:
            out.append(Finding(
                id="A-7", severity="S1",
                span=src, before=src, after=dst,
                reason="have/make/take light-verb 직역",
            ))
    return out


def _detect_a8_double_passive(text: str) -> list[Finding]:
    out: list[Finding] = []
    for src, dst in DOUBLE_PASSIVE_TOKENS.items():
        if src == dst:
            continue
        if src in text:
            out.append(Finding(
                id="A-8", severity="S1",
                span=src, before=src, after=dst,
                reason="이중 피동",
            ))
    return out


def _detect_a19_double_particle(text: str) -> list[Finding]:
    out: list[Finding] = []
    for p in DOUBLE_PARTICLES:
        if p in text:
            out.append(Finding(
                id="A-19", severity="S2",
                span=p, before=p, after="(절·구로 풀어쓰기 — 메인 에이전트 판단)",
                reason="이중 조사",
            ))
    return out


def _detect_b1_paren_english(text: str) -> list[Finding]:
    """B-1: same Korean+English-paren pair appearing 2+ times."""
    matches = KOR_PAREN_ENG_RE.findall(text)
    counts: dict[tuple[str, str], int] = {}
    for kor, eng in matches:
        key = (kor, eng.strip())
        counts[key] = counts.get(key, 0) + 1
    out: list[Finding] = []
    for (kor, eng), cnt in counts.items():
        if cnt >= 2:
            full = f"{kor}({eng})"
            out.append(Finding(
                id="B-1", severity="S2",
                span=full, before=full, after=kor,
                reason=f"동일 영어 병기 {cnt}회 — 첫 등장 외 제거",
            ))
    return out


def _detect_c5_emoji(text: str, genre: str) -> list[Finding]:
    if genre not in ("column", "report", "formal"):
        return []
    out: list[Finding] = []
    for m in EMOJI_RE.finditer(text):
        emoji = m.group(0)
        out.append(Finding(
            id="C-5", severity="S1",
            span=emoji, before=emoji, after="",
            reason="이모지 (장르 칼럼/리포트/공적)",
        ))
    return out


def _detect_c9_numbered_paren(text: str) -> list[Finding]:
    out: list[Finding] = []
    matches = NUMBERED_PAREN_RE.findall(text)
    if len(matches) >= 3:
        # Report only once with span = the first occurrence
        out.append(Finding(
            id="C-9", severity="S2",
            span=matches[0], before=matches[0],
            after="(본문에 녹이거나 줄바꿈으로 — 메인 에이전트 판단)",
            reason=f"숫자 괄호 인덱싱 {len(matches)}회",
        ))
    return out


def _detect_c11_connective_comma(text: str) -> list[Finding]:
    out: list[Finding] = []
    seen: set[str] = set()
    for m in CONNECTIVE_COMMA_RE.finditer(text):
        full = m.group(0)
        ending = m.group(1)
        # Exclude conjunction adverbs that happen to end in the same syllables
        if ending in _C11_FALSE_POSITIVES:
            continue
        if full in seen:
            continue
        seen.add(full)
        out.append(Finding(
            id="C-11", severity="S1",
            span=full, before=full, after=ending,
            reason="연결어미 뒤 쉼표 제거",
        ))
    return out


def _detect_d1_conclusion_pivot(text: str) -> list[Finding]:
    total = sum(text.count(w) for w in CONCLUSION_PIVOTS)
    if total <= 3:
        return []
    out: list[Finding] = []
    for w in CONCLUSION_PIVOTS:
        cnt = text.count(w)
        if cnt > 0:
            out.append(Finding(
                id="D-1", severity="S1",
                span=w, before=w,
                after="(첫 1~2건만 다른 종결로, 나머지 삭제 — 메인 에이전트 판단)",
                reason=f"결산 피벗 누적 {total}회 (임계 3 초과)",
            ))
    return out


def _detect_d2_cliche_eval(text: str) -> list[Finding]:
    out: list[Finding] = []
    for w in CLICHE_EVAL:
        if w in text:
            out.append(Finding(
                id="D-2", severity="S1",
                span=w, before=w, after="",
                reason="평가 클리셰 (삭제 또는 구체 결론)",
            ))
    return out


def _detect_d3_essence_filler(text: str) -> list[Finding]:
    out: list[Finding] = []
    for w in ESSENCE_FILLER:
        if w in text:
            out.append(Finding(
                id="D-3", severity="S1",
                span=w, before=w, after="",
                reason="공허한 강조 부사 — 삭제",
            ))
    return out


def _detect_d4_hype(text: str) -> list[Finding]:
    total = sum(text.count(w) for w in HYPE_WORDS)
    if total < 3:
        return []
    out: list[Finding] = []
    for w in HYPE_WORDS:
        cnt = text.count(w)
        if cnt > 0:
            out.append(Finding(
                id="D-4", severity="S1",
                span=w, before=w,
                after="(삭제 또는 구체 수치·사실로 — 메인 에이전트 판단)",
                reason=f"hype 어휘 누적 {total}회 (임계 3)",
            ))
    return out


def _detect_d6_closing_formula(text: str) -> list[Finding]:
    out: list[Finding] = []
    for w in CLOSING_FORMULA:
        if w in text:
            out.append(Finding(
                id="D-6", severity="S1",
                span=w, before=w,
                after="(평서로 닫거나 삭제 — 메인 에이전트 판단)",
                reason="결말 공식",
            ))
    return out


def _detect_g1_will_be(text: str) -> list[Finding]:
    cnt = text.count("것이다") + text.count("할 것이다")
    if cnt < 5:
        return []
    return [Finding(
        id="G-1", severity="S2",
        span="것이다", before="것이다",
        after="(현재형·확정형으로 — 메인 에이전트 판단)",
        reason=f"미래 단정 어미 {cnt}회",
    )]


def _detect_g2_seems(text: str) -> list[Finding]:
    cnt = text.count("로 보인다") + text.count("인 듯하다")
    if cnt < 4:
        return []
    return [Finding(
        id="G-2", severity="S2",
        span="로 보인다", before="로 보인다",
        after="(단언 가능한 곳은 단언 — 메인 에이전트 판단)",
        reason=f"추정 어미 {cnt}회",
    )]


def _detect_g3_safe_balance(text: str) -> list[Finding]:
    total = sum(text.count(w) for w in SAFE_BALANCE)
    if total < 4:
        return []
    out: list[Finding] = []
    for w in SAFE_BALANCE:
        cnt = text.count(w)
        if cnt > 0:
            out.append(Finding(
                id="G-3", severity="S2",
                span=w, before=w,
                after="(1~2건만 화자 입장, 나머지 삭제 — 메인 에이전트 판단)",
                reason=f"안전 균형 lexicon 누적 {total}회",
            ))
    return out


def _detect_h1_initial_connectives(text: str) -> list[Finding]:
    counts = {w: _initial_connective_count(text, w) for w in INITIAL_CONNECTIVES}
    total = sum(counts.values())
    if total < 5:
        return []
    out: list[Finding] = []
    for w, cnt in counts.items():
        if cnt > 0:
            out.append(Finding(
                id="H-1", severity="S1",
                span=w, before=w,
                after="(문두 접속사 대량 제거 — 메인 에이전트 판단)",
                reason=f"문두 접속사 누적 {total}회 (임계 5)",
            ))
    return out


def _detect_h3_meta_entry(text: str) -> list[Finding]:
    total = sum(text.count(w) for w in META_ENTRY)
    if total < 3:
        return []
    out: list[Finding] = []
    for w in META_ENTRY:
        cnt = text.count(w)
        if cnt > 0:
            out.append(Finding(
                id="H-3", severity="S1",
                span=w, before=w,
                after="(본문에 녹이거나 삭제 — 메인 에이전트 판단)",
                reason=f"메타 진입 누적 {total}회",
            ))
    return out


def _detect_h4_jeuk(text: str) -> list[Finding]:
    cnt = _initial_connective_count(text, "즉") + text.count(" 즉,") + text.count(" 즉.")
    if cnt < 2:
        return []
    return [Finding(
        id="H-4", severity="S2",
        span="즉", before="즉",
        after="(1회로 제한 — 메인 에이전트 판단)",
        reason=f"'즉' 남발 {cnt}회",
    )]


def _detect_i1_kotida(text: str) -> list[Finding]:
    out: list[Finding] = []
    for ending in CLOSING_INSANG_KOTIDA:
        if ending in text:
            out.append(Finding(
                id="I-1", severity="S1",
                span=ending, before=ending,
                after="(평서형으로 — 메인 에이전트 판단)",
                reason="형식명사 결말",
            ))
    return out


def _detect_i3_dan_ttutida(text: str) -> list[Finding]:
    out: list[Finding] = []
    for ending in CLOSING_DAN_TTUTIDA:
        if ending in text:
            out.append(Finding(
                id="I-3", severity="S2",
                span=ending, before=ending,
                after="(본문에 풀어 쓰기 — 메인 에이전트 판단)",
                reason="잉여 의미 풀이 결말",
            ))
    return out


def _detect_j2_quote_emphasis(text: str) -> list[Finding]:
    matches = QUOTED_EMPHASIS_RE.findall(text)
    if len(matches) < 5:
        return []
    return [Finding(
        id="J-2", severity="S1",
        span=matches[0], before=matches[0],
        after="(핵심 한두 개만 살리고 평어로 — 메인 에이전트 판단)",
        reason=f"따옴표 강조 {len(matches)}회",
    )]


def _detect_j3_bullets(text: str, genre: str) -> list[Finding]:
    if genre not in ("column", "report", "formal"):
        return []
    bullets = BULLET_LINE_RE.findall(text)
    if len(bullets) < 3:
        return []
    first_match = BULLET_LINE_RE.search(text)
    span = first_match.group(0) if first_match else "- "
    return [Finding(
        id="J-3", severity="S2",
        span=span, before=span,
        after="(문단 산문으로 통합 — 메인 에이전트 판단)",
        reason=f"불릿 리스트 {len(bullets)}항 (장르 {genre})",
    )]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def detect(text: str, genre: str = "column") -> dict:
    detectors = (
        _detect_a7_light_verb,
        _detect_a8_double_passive,
        _detect_a19_double_particle,
        _detect_b1_paren_english,
        _detect_c9_numbered_paren,
        _detect_c11_connective_comma,
        _detect_d1_conclusion_pivot,
        _detect_d2_cliche_eval,
        _detect_d3_essence_filler,
        _detect_d4_hype,
        _detect_d6_closing_formula,
        _detect_g1_will_be,
        _detect_g2_seems,
        _detect_g3_safe_balance,
        _detect_h1_initial_connectives,
        _detect_h3_meta_entry,
        _detect_h4_jeuk,
        _detect_i1_kotida,
        _detect_i3_dan_ttutida,
        _detect_j2_quote_emphasis,
    )
    findings: list[Finding] = []
    for fn in detectors:
        findings.extend(fn(text))
    # Genre-gated rules
    findings.extend(_detect_c5_emoji(text, genre))
    findings.extend(_detect_j3_bullets(text, genre))
    # Dedupe identical (id, span) pairs
    seen: set[tuple[str, str]] = set()
    unique: list[Finding] = []
    for f in findings:
        key = (f.id, f.span)
        if key in seen:
            continue
        seen.add(key)
        unique.append(f)
    return {
        "char_count": len(text),
        "genre": genre,
        "findings": [asdict(f) for f in unique],
    }


def _main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="zkorean static detector")
    parser.add_argument("--input", required=True)
    parser.add_argument("--genre", default="column",
                        help="column (default) | report | blog | formal")
    parser.add_argument("--output", default=None,
                        help="Output JSON path. Default: stdout.")
    args = parser.parse_args(argv)

    with open(args.input, "r", encoding="utf-8") as f:
        text = f.read()

    result = detect(text, genre=args.genre)
    out = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out)
    else:
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(_main())
