---
name: diagram
description: "Use when the user asks for something to be shown visually and the kind of picture is not yet decided. Triggers: '비주얼로 표현해줘', '다이어그램 그려줘', '그림으로', '시각화해줘', 'visualize', 'draw diagram', 'show as diagram'."
allowed-tools: Read, Bash
version: 1.2.0
license: MIT
---

# Diagram Router

Classify the user's visual request into ONE of six categories, then delegate to the matching skill. Single-turn execution: classify → invoke → endTurn. No preamble, no follow-up question unless the input is truly unclassifiable.

## Step 0 — what the reader decides, and what the picture must show

Before scoring, write two lines and pass them to the delegate with the request:

1. **Decision and conclusion** — "Looking at this, the reader decides ___; the picture must make ___ visible." The
   second half becomes the picture's title: it states the finding ("Air는 통제에서, soma-work는 스레드에서 출발한다"),
   not the scope ("Air vs soma-work 비교"). The upload comment opens with the same line.
2. **Relation** — what the picture shows: a system or a flow (ARCHITECTURE), options set side by side
   (COMPARISON), numbers (NUMERIC), one measured UI component or product (DRAWING), an idea (GENERAL).

A request that matches no keyword below is classified by this relation, never by the tie rule — a
comparison with no signal word once became a dark infrastructure diagram with invented arrows.

**A picture inside a report.** When the same request also asks you to make a report or page as its output
(`리포트해줘`, `보고서로 만들어줘`, `페이지로`, `report on`) — not when a report is only the subject ("보고서 디자인을
바꿀지") — the picture is part of that page: render it, then embed the PNG in the html page (`<img src="data:image/png;base64,…" alt="<conclusion>">`)
right after the page's opening, and upload the page only — one request, one artifact. A comparison the report
already shows as a table needs no second picture of the same table.

## Classification

Score the user's own request sentence against these signal sets — whole words, not substrings, and not the material they pasted (a pasted spec full of "대시보드" or "pipeline" is the subject, not the ask). Pick the category with the highest score. Ties between categories that scored go to **ARCHITECTURE**, after the DRAWING and COMPARISON precedences below; a request that scored nothing goes to Step 0's relation.

| Category | Korean signals | English signals | Delegate to |
|----------|----------------|-----------------|-------------|
| **ARCHITECTURE** | 아키텍처, 아키텍쳐, 구조도, 시스템 구성, 컴포넌트, 서비스 구성, 플로우차트, 순서도, 관계도, 의존, 기대는 관계, 연결 관계, 흐름 | architecture, system diagram, component, service, flowchart, sequence, dependency graph, topology | `local:architecture-diagram` |
| **NUMERIC** | 차트, 그래프, 매출, 증가율, 분포, 추이, 수치, 통계, 히스토그램 | chart, graph, plot, bar, line, histogram, distribution, trend, metric, percentage, over time | `stv:using-terminal-charts` |
| **GENERAL** | 그림, 일러스트, 개념도, 설명 그림, 아이콘, 스케치 | illustration, sketch, concept, explain visually, conceptual | vendored Excalidraw renderer (see **GENERAL** below) |
| **COMPARISON** | 비교, 대조, 차이, 어떻게 다른지, 나란히, 장단점, vs | compare, comparison, versus, vs, difference, side by side, trade-off | vendored Excalidraw renderer, comparison layout (see **COMPARISON** below) |
| **DRAWING** | 도면, 치수, 치수 도면, 컴포넌트 해부, UI 해부, 스펙 시트, 레드라인, 사이트 뜯어줘, 컴포넌트 뜯어줘 | dimensional drawing, component anatomy, UI anatomy, spec sheet, redline, measured drawing | `local:dimensional-drawing` |
| **MIXED** | 두 개 이상 신호 동시 등장 (예: "아키텍처 + 성능 수치") | architecture+numeric both present | ARCHITECTURE first, then NUMERIC |

**Classification rule**: keyword count wins, with one precedence: DRAWING wins over ARCHITECTURE when a DRAWING signal is present AND the subject is one UI component, page or physical product (a file, URL, screenshot or named component). "Component" is a generic ARCHITECTURE signal, while a request for a 도면 / anatomy / spec sheet of a UI component asks for a measured drawing of that one component, not a system diagram. A DRAWING word aimed at a system, service or request flow ("서비스 구조 뜯어서 그려줘", "anatomy of the request flow") stays ARCHITECTURE. COMPARISON wins over ARCHITECTURE when the request sets two or more named options against each other (products, designs, documents, plans), even when it also says 구조 or component: the reader is choosing between the options, not tracing one system. Otherwise, if the user supplies BOTH structural nouns (component/service/flow) AND numeric nouns (chart/metric/percentage), treat as MIXED and execute both in order.

## Execution

### ARCHITECTURE
Invoke the Skill tool with `skill="local:architecture-diagram"` and pass the user's original request as context. Do not re-interpret — let the sub-skill handle palette and JSON generation.

### COMPARISON
Draw the options as columns and the compared attributes as rows (a matrix), on the light canvas of **GENERAL** — its palette, and architecture-diagram's Steps 3–6.5 (bootstrap, pre-flight, render, validate, critic; read the critic's contrast item as 4.5:1 on the light canvas). Matrix cells have square corners (`roundness: null`), so a drawn radius is never confused with the cell's own. Show each value as itself where it can be seen — a colour as a swatch, a size or radius drawn to scale, a count as a short bar — with its text next to it; mark the odd one out in each row (the value that differs from the others) with a heavier border or a dot and leave shared values plain; when every option differs, mark none and say "모두 다름" in the row label. A row of verdicts (who is ahead on this attribute) gets its own colour key in a legend. No arrows unless the input states a flow between the options. Title = Step 0's conclusion.

### DRAWING
Invoke the Skill tool with `skill="local:dimensional-drawing"` and pass the user's original request plus the source (repo file, URL or screenshot). If the user also asks for motion (영상, 애니메이션, animate), run `local:dimensional-drawing-motion` on the finished sheet afterwards.

### NUMERIC
Invoke the Skill tool with `skill="stv:using-terminal-charts"`. If that plugin is not installed on this environment, fall back to **GENERAL** with a note: "stv:using-terminal-charts not available — rendering as general diagram."

### GENERAL
No dedicated numeric-chart or component-architecture skill fits. Use the vendored Excalidraw renderer directly with a LIGHT background palette (this is the concept/illustration path, not the system-architecture path):

1. Write `$(pwd)/diag-<slug>-<ts>.excalidraw` (title = Step 0's conclusion) with:
   - `appState.viewBackgroundColor`: `"#ffffff"`
   - Text `strokeColor`: `"#1e293b"` (slate-800) — dark-on-light
   - Shape fills: soft pastels (`#dbeafe` blue, `#dcfce7` green, `#fef3c7` amber, `#fce7f3` pink)
   - `roughness: 0`, `roundness: { "type": 3 }`
2. Render with architecture-diagram's Steps 3–5 (its virtualenv, pinned-module pre-flight and load wait apply here too). Resolve the path before the `cd` — after it, `$(pwd)` is the plugin folder:
   ```bash
   export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<base directory>/../..}"
   export UV_PROJECT_ENVIRONMENT="${TMPDIR:-/tmp}/soma-excalidraw-venv"
   JSON="$(pwd)/diag-<slug>-<ts>.excalidraw"
   cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references" && uv run python render_excalidraw.py "$JSON"
   ```
3. Validate (same PNG composite checks as architecture-diagram step 6).
4. Upload the PNG alone via `mcp__slack-mcp__send_media` — one illustration, one artifact. Keep the `.excalidraw` in the working directory and name its path in the reply; send it with `mcp__slack-mcp__send_file` only when the user asks for the editable source.

### MIXED
Execute ARCHITECTURE first (full workflow, upload). Then execute NUMERIC. Each delivers its own artifact. Do not try to merge them into one image.

## Unclassifiable input

If the request has no directional verbs, no components, no numeric nouns, AND no clear subject (e.g., just "그려줘" or "draw"), ask ONE structured question via UIAskUserQuestion:

```
question: "What should I draw?"
choices:
  - architecture  (시스템 구조도)
  - comparison    (나란히 비교 — 선택지 × 항목)
  - chart         (수치/통계 차트)
  - illustration  (일반 개념도)
  - drawing       (컴포넌트 치수 도면)
```

Do not guess. Do not stall on unclassifiable input — ask once, then proceed.

## Anti-patterns

- Do NOT describe what you are about to do. Just classify and invoke.
- Do NOT re-implement architecture palette here. Delegate.
- Do NOT merge architecture + numeric into one image. Keep them as separate artifacts.
- Do NOT fall back silently. If a delegate skill is missing, log the reason in one line before falling back.
- Do NOT retry at the router. The delegate's own retry budget (architecture-diagram Step 7) is the only one; if it is spent, surface the error once and endTurn.

## End turn

One line that states the picture's conclusion (Step 0), then the artifact path. No sub-skill name first, no preamble, no trailing question.
