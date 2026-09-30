---
name: diagram
description: Router skill that classifies visual requests and delegates to the right renderer. Triggers on "비주얼로 표현해줘", "다이어그램 그려줘", "그림으로", "시각화해줘", "visualize", "draw diagram", "visualize this", "show as diagram". Single turn; no preamble.
allowed-tools: Read, Bash
version: 1.0.0
license: MIT
---

# Diagram Router

Classify the user's visual request into ONE of five categories, then delegate to the matching skill. Single-turn execution: classify → invoke → endTurn. No preamble, no follow-up question unless the input is truly unclassifiable.

## Step 0 — Reader decision (before scoring)

Answer in one sentence: "Looking at this, the reader decides ___." The user's stated purpose and output format win over keyword counts:
- The question is how a repo's work is split and how far it got (recent work, progress, deploys, epics) → **WORK-STRUCTURE**, and this beats the score table.
- The user asks for a trend, rate, distribution, or chart → **NUMERIC**, even when the subject is a repo's work.
- Both → deliver WORK-STRUCTURE and NUMERIC, as separate artifacts.
Only when Step 0 picks nothing, use the score table below.

## Classification

Score the user's request against these signal sets. Pick the category with the highest score. Ties go to **WORK-STRUCTURE** when the subject is a repo's work, otherwise **ARCHITECTURE**.

| Category | Korean signals | English signals | Delegate to |
|----------|----------------|-----------------|-------------|
| **WORK-STRUCTURE** | 작업, 최근 작업, 진행, 현황, 배포, 에픽, 이슈, PR, 로드맵, 어디까지 | work, progress, status, deploys, epic, issue, PR, roadmap, what shipped | `local:structurize` → `local:html` (see **WORK-STRUCTURE** below) |
| **ARCHITECTURE** | 아키텍처, 아키텍쳐, 구조도, 시스템 구성, 컴포넌트, 서비스 구성, 플로우차트, 순서도, 관계도 | architecture, system diagram, component, service, flowchart, sequence, dependency graph, topology | `local:architecture-diagram` |
| **NUMERIC** | 차트, 그래프, 매출, 증가율, 분포, 추이, 수치, 통계, 히스토그램 | chart, graph, plot, bar, line, histogram, distribution, trend, metric, percentage, over time | `stv:using-terminal-charts` |
| **GENERAL** | 그림, 일러스트, 개념도, 설명 그림, 아이콘, 스케치 | illustration, sketch, concept, explain visually, conceptual | vendored Excalidraw renderer (see **Fallback** below) |
| **MIXED** | 두 개 이상 신호 동시 등장 (예: "아키텍처 + 성능 수치") | architecture+numeric both present | ARCHITECTURE first, then NUMERIC |

**Classification rule**: Step 0 first; keyword count only when Step 0 picks nothing. If the user supplies BOTH structural nouns (component/service/flow) AND numeric nouns (chart/metric/percentage), treat as MIXED and execute both in order.

## Execution

### WORK-STRUCTURE
1. Open the repo's human-made structure first: `.prd/`, ssot/loop files, `docs/`, epic/issue labels, PR title convention. Use it as the intended skeleton (root → epic → issue → sub-issue → PR/commit), then check it against code, issues and deploy receipts and mark every mismatch. Never invent a layer the repo does not have. With no structure docs, reconstruct from PRs/commits and say so on the page.
2. Every node carries an evidence link (PRD path / issue / PR / commit) and a status (shipped / verified / partial / open). Map deploys onto the tree (which epic shipped in which version).
3. Line counts, if shown, are split code / tests / docs / ops from first-parent `git diff --numstat` of the merge commit, generated files excluded and labeled. Never the raw `gh` additions/deletions.
4. First screen = what the reader can decide (one line) → the tree (≤8 lines) → how far to read. Detail after.
5. Pass the structure, evidence, original request and acceptance to `local:structurize`, then its result to `local:html`. If either skill is missing, say so in one line — do not substitute a different kind of artifact.

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
  - work          (작업 구조 트리 — 에픽/이슈/PR/배포)
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
