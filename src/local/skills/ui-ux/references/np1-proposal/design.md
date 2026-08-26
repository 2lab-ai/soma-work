# Design Reference — np1-proposal

- **Name:** `np1-proposal`
- **Source:** file:///Users/zhugehyuk/2lab.ai/soul/np1/data/briefings/s26-ultra-decision.html
- **Type:** Decision-first executive proposal / comparison brief
- **Recognition:** Primary observed np1 briefing artifact; no external award metadata
- **Studio:** np1 (source artifact attribution; individual designer not stated)
- **Captured:** 2026-08-26

## Vibe (one line)

Decision before decoration — a white executive brief that states the answer first,
then earns it with restrained navy hierarchy, semantic evidence, dense comparison
tables, and one unmistakable recommendation.

## Color Palette

| Role | Value | Notes |
|------|-------|-------|
| Canvas | `#FFF` | observed page canvas; clean white report field |
| Primary text | `#1a1a1a` | observed body copy; softer than pure black |
| Navy / authority | `#0a2540` | observed h1, h2, summary rule, and verdict gradient start |
| Blue / section signal | `#2563eb` | observed h2 left rule; primary web accent |
| Deep blue | `#1e40af` | observed h3 and verdict gradient end |
| Good | `#16a34a` | observed positive semantic text; always pair with explicit positive wording |
| Bad | `#dc2626` | observed negative semantic text; always pair with explicit risk/cost wording |
| Neutral | `#475569` | observed neutral semantic text and supporting explanation |
| Table head | `#e2e8f0` | observed header-row fill |
| Table stripe | `#f8fafc` | observed even-row zebra fill |
| Summary | `#f1f5f9` | observed conclusion-panel fill |
| Pick | `#fbbf24` | observed final-pick text and verdict h2 rule |

Supporting borders use the observed cool gray `#cbd5e1`; positive and negative
badges may use pale semantic fills, but the dominant field remains white. Color is
rationed by function: navy establishes authority, blue marks sections, green/red
encode evaluated outcomes, and yellow appears only on the final pick.

> Accessibility caveat: never communicate good/bad/neutral status by color alone;
> retain labels such as “good”, “risk”, “higher cost”, or equivalent visible text.
> The observed green `#16a34a` on `#FFF` does not reliably reach 4.5:1 for small
> body text, so reserve it for sufficiently large/bold text or darken the web text
> token after contrast testing. Verify every semantic pair, the yellow pick on the
> gradient, and badge foreground/fill combinations against WCAG AA.

## Typography

- **Observed family:** `'Pretendard', 'Noto Sans KR', 'Apple SD Gothic Neo',
  sans-serif` — one pragmatic Korean-capable sans stack across the brief.
- **Observed print scale:** 22pt h1, 14pt h2, 12pt h3, 11pt body, 10pt tables,
  9.5pt metadata, and 9pt footnotes. Preserve the decisive jumps in hierarchy.
- **Web adaptation:** use fluid headings, but keep body copy at `16px` or larger on
  mobile with a 1.55–1.65 line-height. Metadata and footnotes may step down only
  when contrast and readability remain adequate.
- **Weight:** 700 for the chosen option and conclusion; 600 for table headers,
  badges, and semantic outcomes; 400 for explanatory prose.
- **Numerals:** use `font-variant-numeric: tabular-nums` and right alignment for
  costs, percentages, durations, and totals.

## Layout & Grid

- The source is an A4-oriented single report column. For web, add
  `<meta name="viewport" content="width=device-width, initial-scale=1">` and place
  the report in a centered responsive container (`width: min(100% - 32px, 1120px)`).
- Preserve this decision-first information order exactly:
  1. title and metadata;
  2. one-line conclusion;
  3. comparisons and facts;
  4. decision matrix;
  5. final recommendation;
  6. action plan;
  7. sources and footnotes.
- **h1 grammar:** navy text with a strong navy bottom rule and compact lower gap.
- **h2 grammar:** navy text with a blue left rule; h3 uses deep blue.
- **Summary grammar:** cool-gray summary fill, navy left rule, compact padding, and
  the recommendation stated in the first sentence.
- **Evidence grammar:** full-width bordered tables, cool-gray header cells, zebra
  rows, concise labels, and right-aligned tabular numeric columns.
- **Verdict grammar:** navy-to-deep-blue gradient, white body text, yellow h2 rule,
  and a yellow, bold pick line. This is the only saturated large-area treatment.
- **Badge grammar:** compact rounded pills for bounded states, with text labels in
  addition to semantic color.
- Use one vertical document scroll. On narrow screens, only a `.table-scroll`
  wrapper may scroll horizontally; the page itself must have zero horizontal
  overflow (`documentElement.scrollWidth === documentElement.clientWidth`).
- Stack dense comparison content rather than shrinking it. Keep mobile body text
  at least `16px`, preserve 16px minimum side gutters, and avoid fixed-width tables.

## Motion & Interaction

The observed artifact is static; confidence comes from reading order, not motion.

- Do not add scroll reveals, animated counters, parallax, or decorative loaders.
- Links may use a short 150–200ms underline/color transition; sortable tables may
  expose a restrained state change only when sorting is a real function.
- Give keyboard users a visible blue focus ring and keep table-scroll regions
  keyboard reachable with an accessible label when they overflow.
- Respect `prefers-reduced-motion`; the complete brief must remain immediately
  readable with all motion disabled.

## Imagery & Texture

- No imagery is required or observed. The texture is typographic: rules, borders,
  zebra rows, semantic labels, and numeric alignment.
- Keep surfaces flat. Aside from the verdict gradient, avoid decorative gradients,
  photography, illustrations, glass effects, and heavy shadows.
- Replace structural emoji section markers with numbered text labels (`01`, `02`,
  …) or a consistent accessible SVG icon set. Preserve the np1 grammar — summary,
  comparison tables, decision matrix, verdict, action plan — rather than stripping
  the structure along with the emoji.

## Tone / Mood

Executive, direct, evidence-backed, and calm. The reader should know the answer in
one line, understand the trade-offs by scanning, and leave with an ordered action
plan. It is a decision document, not a decorative dashboard or marketing page.

## Signature Techniques to Reproduce

1. Lead with title/meta and a one-line conclusion before any detailed evidence.
2. Use navy rules and blue section markers to make a long report instantly scannable.
3. Present comparisons in bordered zebra tables with tabular numeric alignment.
4. Pair good/bad semantic colors with explicit text; use rounded badges for states.
5. Close the evidence chain with a navy-to-blue verdict, yellow pick, and numbered
   action plan, followed by sources and footnotes.

## Do / Don't

- **Do** keep the decision-first information order; the conclusion is not a reveal.
- **Do** separate facts, comparisons, the decision matrix, recommendation, and actions.
- **Do** use the exact observed palette as the source record and semantic tokens in code.
- **Do** preserve readable labels when color, badges, or SVGs are removed by assistive tech.
- **Do** keep horizontal scrolling inside table wrappers only.
- **Don't** change the OpenAI reference or make `np1-proposal` the global default.
- **Don't** use green/red as the sole signal or force small low-contrast semantic text.
- **Don't** replace dense tables with tiny cards that destroy row-wise comparison.
- **Don't** scatter yellow outside the final pick or expand the verdict gradient elsewhere.
- **Don't** retain platform-dependent emoji as structural icons; use numbered text or SVG.
- **Don't** add ornamental motion, imagery, glassmorphism, or heavy shadows.

## Implementation Notes

- Observed source is a self-contained HTML/CSS document with no JavaScript and a
  system Korean sans stack; keep the adaptation dependency-free unless interaction
  has a demonstrated need.
- Define semantic CSS tokens once: `--canvas:#FFF`, `--text:#1a1a1a`,
  `--navy:#0a2540`, `--blue:#2563eb`, `--deep-blue:#1e40af`,
  `--good:#16a34a`, `--bad:#dc2626`, `--neutral:#475569`,
  `--table-head:#e2e8f0`, `--table-stripe:#f8fafc`,
  `--summary:#f1f5f9`, and `--pick:#fbbf24`.
- Use semantic HTML: one h1, sequential h2/h3 headings, `<table>` with `<caption>`,
  `<thead>`, `<tbody>`, and scoped `<th>` elements, ordered lists for action steps,
  and a footer/notes region for sources.
- Web baseline: `box-sizing:border-box`; `html, body { max-width:100%;
  overflow-x:hidden; }`; responsive max-width container; `.table-scroll {
  max-width:100%; overflow-x:auto; }`; tables may set a content-driven `min-width`.
- Validate at 320px, 375px, 768px, and desktop widths. The acceptance check is zero
  page-level horizontal overflow, with any necessary overflow isolated to tables.
- Print may retain the observed A4 margins and point scale; web must not inherit
  print-small typography. Keep mobile body text at least `16px` and never disable zoom.
- Test contrast, keyboard focus, heading order, table semantics, reduced motion, and
  zoom to 200% before treating the reference as implementation-ready.
