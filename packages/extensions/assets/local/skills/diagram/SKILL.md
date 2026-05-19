---
name: diagram
description: Router skill that classifies visual requests and delegates to the right renderer. Triggers on "비주얼로 표현해줘", "다이어그램 그려줘", "그림으로", "시각화해줘", "visualize", "draw diagram", "visualize this", "show as diagram". Single turn; no preamble.
allowed-tools: Read, Bash
version: 1.0.0
license: MIT
---

# Diagram Router

Classify the user's visual request into ONE of four categories, then delegate to the matching skill. Single-turn execution: classify → invoke → endTurn. No preamble, no follow-up question unless the input is truly unclassifiable.

## Classification

Score the user's request against these signal sets. Pick the category with the highest score. Ties go to **ARCHITECTURE**.

| Category | Korean signals | English signals | Delegate to |
|----------|----------------|-----------------|-------------|
| **ARCHITECTURE** | 아키텍처, 아키텍쳐, 구조도, 시스템 구성, 컴포넌트, 서비스 구성, 플로우차트, 순서도, 관계도 | architecture, system diagram, component, service, flowchart, sequence, dependency graph, topology | `local:architecture-diagram` |
| **NUMERIC** | 차트, 그래프, 매출, 증가율, 분포, 추이, 수치, 통계, 히스토그램 | chart, graph, plot, bar, line, histogram, distribution, trend, metric, percentage, over time | `stv:using-terminal-charts` |
| **GENERAL** | 그림, 일러스트, 개념도, 설명 그림, 아이콘, 스케치 | illustration, sketch, concept, explain visually, conceptual | vendored Excalidraw renderer (see **Fallback** below) |
| **MIXED** | 두 개 이상 신호 동시 등장 (예: "아키텍처 + 성능 수치") | architecture+numeric both present | ARCHITECTURE first, then NUMERIC |

**Classification rule**: keyword count wins. If the user supplies BOTH structural nouns (component/service/flow) AND numeric nouns (chart/metric/percentage), treat as MIXED and execute both in order.

## Execution

### ARCHITECTURE
Invoke the Skill tool with `skill="local:architecture-diagram"` and pass the user's original request as context. Do not re-interpret — let the sub-skill handle palette and JSON generation.

### NUMERIC
Invoke the Skill tool with `skill="stv:using-terminal-charts"`. If that plugin is not installed on this environment, fall back to **GENERAL** with a note: "stv:using-terminal-charts not available — rendering as general diagram."

### GENERAL
No dedicated numeric-chart or component-architecture skill fits. Use the vendored Excalidraw renderer directly with a LIGHT background palette (this is the concept/illustration path, not the system-architecture path):

1. Write `$(pwd)/diag-<slug>-<ts>.excalidraw` with:
   - `appState.viewBackgroundColor`: `"#ffffff"`
   - Text `strokeColor`: `"#1e293b"` (slate-800) — dark-on-light
   - Shape fills: soft pastels (`#dbeafe` blue, `#dcfce7` green, `#fef3c7` amber, `#fce7f3` pink)
   - `roughness: 0`, `roundness: { "type": 3 }`
2. Render: `cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references" && uv run python render_excalidraw.py "$(pwd)/diag-<slug>-<ts>.excalidraw"`
3. Validate (same PNG composite checks as architecture-diagram step 6).
4. Dual upload via `mcp__slack-mcp__send_media` (PNG) + `mcp__slack-mcp__send_file` (.excalidraw).

### MIXED
Execute ARCHITECTURE first (full workflow, upload). Then execute NUMERIC. Each delivers its own artifact. Do not try to merge them into one image.

## Unclassifiable input

If the request has no directional verbs, no components, no numeric nouns, AND no clear subject (e.g., just "그려줘" or "draw"), ask ONE structured question via UIAskUserQuestion:

```
question: "What should I draw?"
choices:
  - architecture  (시스템 구조도)
  - chart         (수치/통계 차트)
  - illustration  (일반 개념도)
```

Do not guess. Do not stall on unclassifiable input — ask once, then proceed.

## Anti-patterns

- Do NOT describe what you are about to do. Just classify and invoke.
- Do NOT re-implement architecture palette here. Delegate.
- Do NOT merge architecture + numeric into one image. Keep them as separate artifacts.
- Do NOT fall back silently. If a delegate skill is missing, log the reason in one line before falling back.
- Do NOT retry. If the delegate fails, surface the error once and endTurn.

## End turn

One-line confirmation of which sub-skill was invoked and the artifact paths. No preamble, no trailing question.
