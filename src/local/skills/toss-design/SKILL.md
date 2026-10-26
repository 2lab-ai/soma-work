---
name: toss-design
description: 'Toss-style UI design system for HTML output, distilled from the public TDS Mobile (Toss Design System, Apps in Toss) docs. Gives tokens, component recipes (Top, ListRow, ListHeader, Button, BottomCTA, Badge, Tab, TextField, Toast, Dialog, BottomSheet, Skeleton), Korean UX-writing rules and accessibility checks, with a selectable brand colour - theme=toss-blue (default, Toss Blue #3182F6) or theme=toss-black (Toss near-black #191F28). Use when a page, report, mock-up or mini-app screen should look like Toss / TDS, or when another skill (for example an HTML generator) passes theme=toss-blue|toss-black. Triggers on "toss design", "toss style", "TDS", "Toss Design System", "apps in toss", "toss-blue", "toss-black", "토스 디자인", "토스 스타일로", "토스처럼", "토스 느낌", "TDS 스타일", "앱인토스", "토스 블루", "토스 블랙".'
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch
version: 0.1.0
license: "Original distillation of the publicly documented TDS (Toss Design System) design language, written for this skill. TDS, Toss and Apps in Toss marks belong to Viva Republica, Inc. No proprietary Toss assets, fonts, icons, Figma UI Kit parts or package code are vendored; output is Toss-style, not an official Toss product."
---

# toss-design

## What this skill is

A theme-able design system that makes HTML look and read like a Toss screen. It is built from the TDS Mobile docs (https://tossmini-docs.toss.im/tds-mobile/), the published TDS npm packages (values only) and the Apps in Toss design guide. Every value traces to `references/tds-source-notes.md`, where each value is marked observed or inferred.

Use it when:

- a user asks for something "토스 스타일로", "TDS처럼", "toss design";
- another skill renders HTML and passes `theme=toss-blue` or `theme=toss-black`;
- you mock up an Apps in Toss mini-app screen, a Toss-like report or a Toss-like landing section.

Don't use it for brands that are not Toss-like, or to make something that passes itself off as an official Toss product.

## Files

| Path | What it is |
|---|---|
| `SKILL.md` | This file. Self-contained rules, tokens, core recipes. |
| `themes/index.json` | Theme registry. One entry has `"default": true`. |
| `themes/<name>/tokens.css` | `:root` CSS custom properties: raw TDS palette, semantic tokens (same names in every theme), type, radius, spacing, elevation, motion, plus an opt-in strict-AA block. |
| `themes/<name>/design.md` | The theme as a named design reference (ui-ux reference template). Drop-in compatible with other skills' reference libraries. |
| `references/components.md` | Full recipe kit CSS (about 330 lines) and markup for every component. |
| `references/tds-source-notes.md` | Evidence: every URL read, raw values, observed / inferred markers. |
| `scripts/contrast-check.py` | Stdlib-only WCAG contrast report for a tokens file. |
| `__sample__/sample-<theme>.html` | One mobile screen per theme (render it to PNG to look at it). |

## Theme selection

Themes: `toss-blue` (default) and `toss-black`. Both expose identical variable names, so switching theme means swapping one tokens file.

| Theme | Accent | What changes |
|---|---|---|
| `toss-blue` | `#3182F6` (TDS `blue500`, observed) | Nothing: TDS as documented. |
| `toss-black` | `#191F28` (TDS `grey900`, observed) | Primary CTA fill, weak-button tint, selected controls, focus ring, active tab, field focus, links, brand badge. Canvas, greys, status colours, type, spacing, motion stay the same. |

### Resolve a theme (exact algorithm)

1. Read `themes/index.json` (path relative to this skill folder).
2. Requested name = the caller's `theme=` value, or a theme the user named ("토스 블랙", "black", "검정" → `toss-black`; "토스 블루", "blue", "파랑" → `toss-blue`).
3. If an entry's `name` equals the requested name, use it. If no theme was requested, use the entry with `"default": true` (`toss-blue`). If a theme was requested but no entry matches, stop and report the valid names — never fall back silently (the same rule as the `html` skill's `design=` input).
4. Load `entry.tokens` (CSS) and `entry.design` (direction, do/don't).
5. Inline the tokens file verbatim in the first `<style>` block, then the component CSS. Never copy single hex values into component rules: always use `var(--color-…)`.

```html
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
  <style>
    /* contents of themes/<name>/tokens.css */
    /* recipe kit CSS from references/components.md (or the core kit below) */
  </style>
</head>
```

### Options a caller may pass

| Option | Values | Default | Effect |
|---|---|---|---|
| `theme` | `toss-blue`, `toss-black` | `toss-blue` | Picks the tokens file. |
| `contrast` | `tds`, `aa` | `tds` | `aa` adds `data-contrast="aa"` on `<html>`; the tokens file then swaps the few TDS pairs below 4.5:1 (blue500 → blue700 fills, red500 → red700, placeholder grey500 → grey600). Use `aa` for public-sector, compliance or print deliverables. |
| `layout` | `mobile`, `wide`, `auto` | `auto` | See "Desktop-width HTML" below. |
| `dark` | `off` | `off` | Dark mode is not shipped as a theme (see below). |

### Native TDS mechanism (map for real mini-apps)

TDS has its own brand-colour hook, and the two themes map onto it:

- `@toss/tds-mobile-ait` → `<TDSMobileAITProvider brandPrimaryColor="#3182F6">` (toss-blue) or `brandPrimaryColor="#191F28"` (toss-black). If omitted, it uses the app's configured brand colour, else blue500.
- Apps in Toss config: SDK 2.x `granite.config.ts` → `brand.primaryColor`; SDK 3.x `apps-in-toss.config.ts` → `defineConfig({ brand: { primaryColor: '#191F28' } })`.
- What TDS does with it: only Button colour `primary` is derived. For a brand colour with OKLCH lightness below 0.40 (grey900 is 0.24), TDS keeps the fill as-is with a white label, and the weak button becomes `grey700` at 7% with a `grey700` label. toss-black reproduces exactly that.
- What TDS does not do: Switch, Checkbox, Badge `blue`, `Paragraph.Link`, TextField focus stay blue500/600 in TDS 2.5.1. toss-black also moves those to near-black. That part is a skill extension. Say so if someone builds the real app.
- Apps in Toss auto-corrects brand colours that fail its contrast check.

### Dark mode

Dark values exist in `@toss/tds-colors` (`colors.dark.css`; background `#17171c`, grey900 → `#ffffff`, blue500 → `#3485fa`) and are listed in `references/tds-source-notes.md` §1. The docs give no dark-mode guidance, and `TDSMobileAITProvider` forces `colorPreference: "light"`. So both themes ship light only. If a user insists on dark, build a third tokens file from the notes' dark column with the same variable names, and rerun the contrast script.

## Modes

**Programmatic (called by another skill).** Never ask questions. Resolve the theme with the algorithm above, default everything else, produce the HTML, and add one HTML comment that records the choices: `<!-- toss-design theme=toss-blue contrast=tds layout=mobile -->`. If the caller supplies content, keep its facts and numbers exactly; only restyle and rewrite microcopy (labels, buttons, empty states) into 해요체.

**Interactive (a person asked).** If the person did not name a theme, use `toss-blue` and say in one line that `toss-black` exists. Ask at most one question, and only if the answer changes the layout (for example "모바일 화면 하나인가요, 넓은 리포트인가요?"). Then build, render to PNG if a renderer is available, look at it, and fix problems before replying.

## Foundations

All raw values below are observed in TDS sources unless marked [inferred].

### Colour scales (light)

Full scales 50–900 for grey, blue, red, orange, yellow, green, teal, purple and greyOpacity are in `tokens.css` as `--tds-<hue>-<step>` (for example `--tds-blue-500`, `--tds-grey-opacity-100`).

| Step | grey | blue | red | green | orange | yellow | teal | purple |
|---|---|---|---|---|---|---|---|---|
| 50 | #f9fafb | #e8f3ff | #ffeeee | #f0faf6 | #fff3e0 | #fff9e7 | #edf8f8 | #f9f0fc |
| 100 | #f2f4f6 | #c9e2ff | #ffd4d6 | #aeefd5 | #ffe0b0 | #ffefbf | #bce9e9 | #edccf8 |
| 200 | #e5e8eb | #90c2ff | #feafb4 | #76e4b8 | #ffcd80 | #ffe69b | #89d8d8 | #da9bef |
| 300 | #d1d6db | #64a8ff | #fb8890 | #3fd599 | #ffbd51 | #ffdd78 | #58c7c7 | #c770e4 |
| 400 | #b0b8c1 | #4593fc | #f66570 | #15c47e | #ffa927 | #ffd158 | #30b6b6 | #b44bd7 |
| 500 | #8b95a1 | **#3182f6** | #f04452 | #03b26c | #fe9800 | #ffc342 | #18a5a5 | #a234c7 |
| 600 | #6b7684 | #2272eb | #e42939 | #02a262 | #fb8800 | #ffb331 | #109595 | #9128b4 |
| 700 | #4e5968 | #1b64da | #d22030 | #029359 | #f57800 | #faa131 | #0c8585 | #8222a2 |
| 800 | #333d4b | #1957c2 | #bc1b2a | #028450 | #ed6700 | #ee8f11 | #097575 | #73228e |
| 900 | **#191f28** | #194aa6 | #a51926 | #027648 | #e45600 | #dd7d02 | #076565 | #65237b |

Backgrounds: `background #ffffff`, `greyBackground #f2f4f6`, `layeredBackground #ffffff`, `floatBackground #ffffff`, `hairlineBorder #e5e8eb`, dim `rgba(0,0,0,0.2)`, hairline ink `rgba(0,0,33,0.07)` drawn 0.5px.

### Semantic tokens (identical names in both themes)

TDS publishes a palette, not a semantic layer. These names are the skill's mapping of how TDS components use the palette [inferred mapping, observed values].

| Token | toss-blue | toss-black | Use |
|---|---|---|---|
| `--color-primary` | blue500 #3182f6 | grey900 #191f28 | Primary CTA fill, brand accent |
| `--color-on-primary` | #ffffff | #ffffff | Label on primary |
| `--color-primary-weak` | rgba(100,168,255,.15) | rgba(78,89,104,.07) | Weak button background |
| `--color-on-primary-weak` | blue700 | grey700 | Weak button label |
| `--color-primary-text` | blue700 | grey900 (+ underline) | Links / accent text at body size |
| `--color-selected` | blue500 | grey900 | Switch on, checkbox, radio |
| `--color-focus` | blue500 | grey900 | 2px focus ring |
| `--color-tab-indicator` | grey800 | grey900 | Active tab underline |
| `--color-field-focus-label` | blue700 | grey900 | Focused field label |
| `--color-badge-brand-bg` / `-text` | blue 16% / blue800 | grey700 16% / grey700 | Brand badge |
| `--color-bg` / `--color-bg-grey` | #fff / grey100 | same | Canvas / section gap |
| `--color-surface` / `--color-surface-float` | #fff | same | Sheets / dialogs |
| `--color-border` / `--color-hairline` | #e5e8eb / rgba(0,0,33,.07) | same | 1px border / 0.5px divider |
| `--color-text-strong` | grey900 | same | Headlines, key numbers |
| `--color-text` | grey800 | same | Titles, row titles |
| `--color-text-secondary` | grey700 | same | Subtitles, right-side text |
| `--color-text-sub` | grey600 | same | Descriptions on white only |
| `--color-text-sub-on-grey` | grey700 | same | Descriptions on grey100 |
| `--color-text-placeholder` | grey500 | same | Placeholder (hint only) |
| `--color-text-disabled` | grey400 | same | Disabled |
| `--color-icon` / `--color-icon-strong` | grey400 / grey600 | same | Decorative chevron / meaningful icon |
| `--color-neutral` (+ `-weak`) | grey700 (greyOpacity100) | same | TDS "dark" button |
| `--color-danger` / `--color-danger-text` | red500 / red700 | same | Danger fill / error text |
| `--color-success` / `--color-success-text` | green600 / green800 | same | Success icon / text |
| `--color-warning` / `--color-on-warning` | yellow500 / grey800 | same | Warning badge |

### Typography

Use the token pairs; size and line-height always travel together (`--t5-size` / `--t5-lh`).

| Token | Size / line-height | Use (TDS wording) |
|---|---|---|
| t1 | 30 / 40 | 매우 큰 제목 — hero number, big page title |
| st1 · st2 · st3 | 29/38 · 28/37 · 27/36 | Top title "28" uses st2 |
| t2 | 26 / 35 | 큰 제목 |
| st4 · st5 · st6 | 25/34 · 24/33 · 23/32 | 조금 큰 제목 (st5) |
| t3 | 22 / 31 | 일반 제목 — default Top title |
| st7 | 21 / 30 | |
| t4 | 20 / 29 | 작은 제목 — dialog title, 2-row large titles |
| st8 · st9 | 19/28 · 18/27 | 조금 큰 본문 |
| t5 | 17 / 25.5 | 일반 본문 — body, row titles, buttons |
| st10 | 16 / 24 | |
| t6 | 15 / 22.5 | 작은 본문 — descriptions, toasts |
| st11 | 14 / 21 | |
| t7 | 13 / 19.5 | 안 읽어도 됨 — captions, labels, help |
| st12 · st13 | 12/18 · 11/16.5 | 아예 안 읽어도 됨 — legal, footnotes |

Weights: regular 400, medium 500, semibold 600, bold 700 (`--fw-*`). Buttons are 600. Titles are bold. Row titles are bold (2-row) or medium (1-row). Line-height helpers: `--lh-xs` 1.252 (buttons, tabs), `--lh-s` 1.35 (list rows), `--lh-m` 1.5. Text uses `word-break: keep-all` so Korean wraps at word boundaries. TDS scales type with the OS larger-text setting, so don't hard-code tiny caps or squeeze text into fixed heights.

### Font

`--font-sans: "Toss Product Sans", "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", …`

- Toss Product Sans is Toss's proprietary typeface. It is listed first only so that a machine that already has it installed will use it. The skill never ships, links or `@font-face`s it, and never claims the output uses it.
- Pretendard (SIL Open Font License 1.1) is the real web font: load it from jsDelivr (`https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css`). This choice is [inferred]; TDS does not name it.
- Numbers: add `font-variant-numeric: tabular-nums` (`.num`) for amounts in lists and tables.

### Spacing

TDS has no published spacing scale. These values recur across its components [observed values, inferred grouping]: `--gutter` 24px (Top, ListHeader, ListRow, Skeleton side padding), `--gutter-cta` 20px (BottomCTA sides and bottom, field box), `--section-gap` 16px (grey band between sections), steps `--space-4/8/12/16/20/24/32`. ListRow vertical padding 8/12/16/24. Top upper and lower gap 24. ListHeader `24px 0 8px`. Button pairs gap 8px.

### Radius

Small button 8 · medium button 10 · list touch 12 · large button and text field 14 · xlarge/CTA button 16 · switch 15 · card/menu/multi-line toast 20 · dialog 24 · bottom sheet 28 · single-line toast pill 100px. Tokens: `--radius-button-s/m/l/xl`, `--radius-field`, `--radius-row-touch`, `--radius-card`, `--radius-dialog`, `--radius-sheet`, `--radius-toast`, `--radius-full`.

### Elevation

Toss is flat. Lists, rows and sections have no shadow; they are separated by whitespace, 0.5px hairlines and 16px grey bands. Shadows exist only on floating layers: `--shadow-tiny` `0 1px 3px greyOpacity200`, `--shadow-weak` `0 2px 30px greyOpacity200` (toast, tooltip), `--shadow-medium` `0 16px 60px greyOpacity300` (menus). Dialogs and sheets float on a 20% black scrim instead of a shadow.

### Iconography

TDS icons (about 7,000 icons and emoji) are a closed Apps in Toss asset; do not copy them. Draw simple 24px line icons yourself (24×24 viewBox, `currentColor` stroke 1.8–2px, round caps). On screen use 24–40px, one icon at a time, in a 40px `greyOpacity100` tile on the left of a list row. Decorative chevrons use grey400; meaningful icons use grey600 or darker. **Never use emoji as icons.**

### Motion

Observed TDS curves: `--ease-out` `cubic-bezier(.25,.1,.25,1)` (default, 0.5s), `--ease-expo` `(.16,1,.3,1)`, `--ease-back` `(.34,1.56,.64,1)`, `--ease-tds` `(.6,0,0,.6)`. TDS animates with springs. The CSS durations are computed from the spring settings [inferred]: press `--dur-spring-rapid` 150ms, release and indicators `--dur-spring-quick` 220ms, `--dur-spring-medium` 400ms, `--dur-spring-basic` 530ms, `--dur-spring-large` 660ms. Feedback: tappable things scale to 0.96 on press and get a 26% dim (buttons) or a grey 12px-radius layer (list rows). Colour changes take 100ms (buttons), 200ms (fields) and 300ms (tabs). Dialogs fade and scale from 0.9. No decorative motion, no particles. The tokens file zeroes movement under `prefers-reduced-motion`.

## Component recipes (summary)

Full CSS and markup: `references/components.md`. If you can only read this file, the core kit below is enough for a Top + ListHeader + ListRow + Button + BottomCTA screen.

| Component | Key spec |
|---|---|
| TopNavigation | 44px (iOS) / 54px (Android); back chevron 24px in 44px hit area. In real mini-apps the host draws it. |
| Top | Left-aligned page title t3 22/31 bold grey800 (or st2 28); subtitle t5 medium grey700, 4px gap; 24px padding all round. |
| ListHeader | `padding: 24px 0 8px`; title t5 bold grey800 at 24px left; right link t7 grey700; description t7 grey600. |
| ListRow | min 44px; padding 12px 24px; 40px left asset + 12px gap; title t5 bold grey800 / description t6 grey600 at line-height 1.35; right value t5 bold; 24px grey400 chevron; 0.5px hairline indented 24px. |
| Button | xlarge 56/r16/t5 (default), large 48/r14/t5, medium 38/r10/t6, small 32/r8/t7; weight 600; colours primary / dark / danger / light × fill / weak. |
| BottomCTA | Fixed; 36px white fade; `padding: 0 20px 20px`; one xlarge block button, or two with 8px gap (left dark weak "닫기", right primary). |
| Badge | xsmall 10px r9, small 12px r11, medium 13px r12, large 14px r13; bold; fill or weak; blue / teal / green / red / yellow / elephant. |
| Tab | t5 labels; selected grey800 700, others grey600 600; 2px indicator (`--color-tab-indicator`); hairline below. |
| TextField | Label t7 above; box `14px 16px`, r14, greyOpacity50 fill, 1px greyOpacity100 border; help t7 below; focus tint + focus label colour. |
| Toast | White pill r100, t6 semibold greyOpacity800 text, `0 2px 30px` shadow, max 375px, 3s. |
| Dialog | 20% scrim; box max 320px, r24; title t4 bold; description t6 medium grey600; buttons "닫기" (dark weak) + action (primary). |
| BottomSheet | Floating, inset 10px, r28, 48×4px handle, CTA at the bottom. |
| Skeleton | grey100 blocks: title 50%×30 r11, subtitle 33%×22 r9, row 100%×64 r18; 0.6s pulse. |
| Border | Item divider 0.5px hairline (24px inset); section divider 16px grey100 band. |

### Core kit (minimum CSS)

```css
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--color-bg);color:var(--color-text-strong);font-family:var(--font-sans);
  font-size:var(--t5-size);line-height:var(--t5-lh);-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:anywhere}
:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}
.screen{position:relative;max-width:var(--mobile-max);min-height:100dvh;margin:0 auto;background:var(--color-bg);
  padding-bottom:calc(36px + var(--button-h-xl) + var(--gutter-cta))}
.top{padding:24px var(--gutter)}
.top__title{margin:0;font-size:var(--t3-size);line-height:var(--t3-lh);font-weight:700;color:var(--color-text)}
.top__subtitle{margin:0;padding-top:4px;font-size:var(--t5-size);line-height:var(--t5-lh);font-weight:500;color:var(--color-text-secondary)}
.section-gap{height:var(--section-gap);margin:0;border:0;background:var(--color-bg-grey)}
.list-header{display:flex;justify-content:space-between;align-items:center;padding:24px var(--gutter) 8px}
.list-header__title{margin:0;font-size:var(--t5-size);line-height:var(--t5-lh);font-weight:700;color:var(--color-text)}
.list-header__right{font-size:var(--t7-size);line-height:var(--t7-lh);color:var(--color-text-secondary)}
.list{margin:0;padding:0;list-style:none}
.list-row{position:relative;display:flex;align-items:center;min-height:var(--row-min-h);padding:12px var(--gutter)}
.list-row+.list-row::before{content:"";position:absolute;top:0;left:var(--gutter);right:0;height:1px;
  background:linear-gradient(to bottom,var(--color-hairline) 50%,transparent 50%)}
.list-row__left{flex:none;width:40px;height:40px;margin-right:12px;border-radius:32%;display:grid;place-items:center;
  background:var(--tds-grey-opacity-100);color:var(--color-icon-strong)}
.list-row__contents{flex:1;min-width:0;display:flex;flex-direction:column}
.list-row__top{font-size:var(--t5-size);line-height:var(--lh-s);font-weight:700;color:var(--color-text)}
.list-row__bottom{font-size:var(--t6-size);line-height:var(--lh-s);color:var(--color-text-sub)}
.list-row__right{flex:none;margin-left:16px;text-align:right;font-weight:700;color:var(--color-text);font-variant-numeric:tabular-nums}
.list-row__arrow{flex:none;width:24px;height:24px;margin:0 -8px 0 4px;color:var(--color-icon)}
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:96px;min-height:var(--button-h-xl);
  padding:0 28px;border:0;border-radius:var(--radius-button-xl);background:var(--color-primary);color:var(--color-on-primary);
  font:inherit;font-size:var(--t5-size);line-height:var(--lh-xs);font-weight:600;cursor:pointer;
  transition:transform var(--dur-spring-quick) var(--ease-out),background-color var(--dur-color) ease-in-out}
.btn:active{transform:scale(var(--press-scale))}
.btn--weak{background:var(--color-primary-weak);color:var(--color-on-primary-weak)}
.btn--dark.btn--weak{background:var(--color-neutral-weak);color:var(--color-on-neutral-weak)}
.btn--l{min-height:var(--button-h-l);padding:0 16px;border-radius:var(--radius-button-l)}
.btn--block{display:flex;width:100%}
.badge{display:inline-flex;align-items:center;font-size:10px;line-height:1.5em;padding:3px 7px;border-radius:9px;font-weight:600;
  background:var(--color-badge-brand-bg);color:var(--color-badge-brand-text)}
.bottom-cta{position:fixed;left:0;right:0;bottom:0;max-width:var(--mobile-max);margin:0 auto;pointer-events:none}
.bottom-cta::before{content:"";display:block;height:36px;background:linear-gradient(to top,var(--color-bg) 25%,rgba(255,255,255,0))}
.bottom-cta__content{pointer-events:auto;background:var(--color-bg);padding:0 var(--gutter-cta) max(env(safe-area-inset-bottom),var(--gutter-cta));display:flex;gap:8px}
.bottom-cta__content>.btn{flex:1}
```

Screen skeleton: `.screen` → (optional nav) → `.top` → `.section-gap` → `.list-header` → `ul.list > li.list-row` × n → `.bottom-cta`. One primary fill per screen, normally the BottomCTA.

## UX writing (Korean)

From the Apps in Toss UX writing guide (observed). Apply to every label, title, toast, dialog and empty state you write.

1. **해요체 everywhere.** "정리했어요", "확인해 주세요". Never 합니다체 or 반말 in UI.
2. **Active voice.** "등록됐어요" → "등록했어요". Passive only for service end/expiry, effects on the user (연체, 해지, 적용) and reassurance.
3. **Positive framing.** "안 돼요 / 없어요" → "~하면 할 수 있어요". Negative only when policy blocks use (say why) or a feature is unavailable.
4. **Casual honorifics.** Drop "~시", "~께", "계시다", "여쭈다" ("확인하시겠어요?" → "확인할까요?"). "~시나요?" only when asking about the user's own context or a favour.
5. **No noun stacks.** "본인 인증 진행" → "본인 인증을 해요".
6. **"돼요", not "되어요".**
7. **Dialog left button is always "닫기"**, never "취소".
8. **CTA says what happens next** ("자동이체 등록하기", not "좋아요" or a repeat of the headline). No exaggerated helper text above the CTA.
9. Brand names in Korean when possible ("토스", not "Toss").
10. Titles state the result in one line, sentence-style ("이번 달 고정 지출을 정리했어요"). Numbers keep their units ("59,000원", "3일").

Apps in Toss also bans: a bottom sheet on entry, a blocking sheet on back, screens with no way out, surprise full-screen ads. Don't design those, even in a mock.

## Do / Don't

Do:

- Keep the canvas white, separate content with whitespace, 0.5px hairlines and 16px grey bands.
- Lead with a big left-aligned Top title (t3 or st2, bold) and let lists do the rest.
- Use exactly one primary fill per screen, usually the BottomCTA. Secondary actions use `dark weak` or `primary weak`.
- Use greys for hierarchy: grey900/800 titles, grey700 secondary, grey600 descriptions.
- Right-align amounts in rows, bold, with tabular numbers.
- Use the type tokens in pairs and keep `word-break: keep-all`.

Don't:

- Don't add drop shadows, borders or cards around list rows; don't use gradients as decoration (Apps in Toss asks for no decorative effects).
- Don't use the accent for body text in toss-blue (blue500 is 3.71:1); use `--color-primary-text` (blue700).
- Don't use more than one accent hue for "brand"; status reds/greens are for status only.
- Don't put grey600 text on the grey100 band (4.19:1); use `--color-text-sub-on-grey`.
- Don't put white text on primary or danger fills below 17px semibold in toss-blue (see Accessibility).
- Don't use emoji as icons, Toss's own icons or illustrations, or the Toss logo.
- Don't center long body text; don't use all-caps; don't letter-space Korean.

## Accessibility

Contrast, measured with `scripts/contrast-check.py` on each tokens file (WCAG 2.x; composite alpha over white):

| Pair | toss-blue | toss-black | Rule |
|---|---|---|---|
| text-strong / text / text-secondary on bg | 16.56 / 11.00 / 7.11 | same | pass |
| text-sub on bg | 4.62 | same | pass |
| text-sub on bg-grey | 4.19 | same | forbidden → use text-sub-on-grey (6.45) |
| on-primary on primary | **3.71** | 16.56 | toss-blue: restricted (below) |
| primary on bg (non-text) | 3.71 | 16.56 | pass (≥ 3:1) |
| primary-text on bg | 5.41 | 16.56 | pass |
| on-primary-weak on primary-weak | 4.78 | 6.43 | pass |
| focus / selected on bg | 3.71 | 16.56 | pass (≥ 3:1) |
| badge-brand text on bg | 5.47 | 5.61 | pass |
| on-danger on danger | **3.71** | **3.71** | restricted (below) |
| danger-text / success-text on bg | 5.26 / 4.75 | same | pass |
| text-placeholder on bg | **3.04** | **3.04** | restricted: hint only, always with a visible label |
| text-disabled on bg | 2.01 | same | exempt (inactive UI) |

Restrictions:

- **White on blue500 / red500 (3.71:1)** is TDS's own button pairing. It meets 3:1 but not 4.5:1, and the TDS labels (15–17px semibold) are not WCAG "large text". Use it only as a button label at t5 (17px) semibold or larger, on xlarge, large or BottomCTA buttons, never for body copy, captions, badges or small (13px) and medium (15px) buttons. For medium and small buttons in toss-blue use `dark weak` or `primary weak`.
- **Placeholder grey500 (3.04:1)** is a hint only. The field must also have a visible label.
- **Strict AA:** set `<html data-contrast="aa">`. Every required pair then passes in both themes (fills move to blue700 / red700, placeholder to grey600). Verified: 0 failures for both themes in `aa` mode.

Other rules:

- Touch targets at least 44×44px. ListRow min-height is 44px. Small (32px) and medium (38px) buttons need the invisible 44px hit area from the kit.
- Visible focus: 2px `--color-focus` ring with 2px offset on every interactive element (TDS removes outlines; the ring is a skill rule).
- Semantics: Top title is `h1`; ListHeader titles are `h2`; tappable rows are `button` or `role="button"` with `tabindex="0"`; tabs use `tablist` / `tab` / `aria-selected`; switches use `role="switch"`; toasts use `role="status" aria-live="polite"`; dialogs use `role="dialog" aria-modal="true"` with labelled title and description.
- Icon-only buttons need `aria-label` in Korean ("뒤로 가기"). Don't put the element type in the label ("스위치", "체크박스", "탭").
- Links in toss-black are the same colour as text, so they must be underlined.
- Respect `prefers-reduced-motion` (tokens and kit already do).
- Don't block zoom; TDS supports the OS larger-text setting up to about 310%, so let text wrap.

Run the check after any token edit:

```bash
python3 scripts/contrast-check.py themes/toss-blue/tokens.css            # TDS mode
python3 scripts/contrast-check.py themes/toss-blue/tokens.css --mode aa  # strict AA
python3 scripts/contrast-check.py themes/toss-black/tokens.css --markdown
```

## Desktop-width HTML (reports, docs, dashboards)

TDS is a mobile system. Pick the layout with this rule [inferred]:

- **Centred mobile column (`layout=mobile`)** when the content is one task or one flow: a screen, a form, a confirmation, a receipt, a single ranked list, a summary of 10 or fewer items, or any table that fits in 3 columns. Render `.screen` at `max-width: 480px`, centred. At viewport width 600px or more, paint `body` with `--color-bg-grey` and keep the column white. Keep the fixed BottomCTA inside the column.
- **Widened layout (`layout=wide`)** when the content needs width: a table with 4 or more columns, a chart with 6 or more categories or a time axis, side-by-side comparison, or 3 or more independent sections a reader scans in parallel. Then:
  - container `max-width: 1040px`, side padding `var(--gutter)`, canvas `--color-bg-grey`;
  - sections become white panels (`--color-surface`, `border-radius: var(--radius-card)`, no shadow), each laid out internally exactly like a mobile screen (Top-style title, ListHeader, ListRows, 24px gutters);
  - a grid of panels: 2 columns at 960px or more, 1 column below 720px; gap 16px (`--section-gap`);
  - type scale unchanged: page title t2 or t1 at most, panel titles t4, body t5/t6. Don't enlarge type for desktop;
  - tables: header row t7 grey600, body t6/t5, 0.5px hairlines between rows only, amounts right-aligned with tabular numbers, no vertical rules, no zebra stripes;
  - no fixed BottomCTA on desktop: put the single primary action inline at the end, `btn--l` or `btn` with `max-width: 480px`.
- **`layout=auto`** applies the rule above. When in doubt, choose the mobile column: it is the more Toss-like result.

## Verify before you hand over

1. Theme comment and tokens are inlined; no raw hex in component rules.
2. Exactly one primary fill on the screen; every other button is weak or dark.
3. All copy is 해요체, active, positive; dialog left button says "닫기".
4. No emoji icons, no Toss logos, icons or illustrations, no invented figures (keep the caller's facts as given).
5. Render to PNG at 430×932 (mobile) or 1280 wide (wide layout), look at it, fix clipping, overlap and blank areas.
6. Run `scripts/contrast-check.py` if you changed any colour.

## Provenance and limits

- Sources read (2026-10-26): 67 TDS Mobile docs pages (Foundation: Colors, Typography; Components; Hooks; Migration), the docs site CSS, the npm tarballs `@toss/tds-colors@0.1.0`, `@toss/tds-mobile@2.5.1`, `@toss/tds-mobile-ait@2.5.1`, and the Apps in Toss design guide (`design/consumer-ux-guide.md`, `design/components.md`, `design/prepare/figma-ui-license.md`). Full list: `references/tds-source-notes.md` §0.
- Not found in any source: a Light font-weight number, a public licence for Toss Product Sans, foundation pages for spacing, radius, elevation, icons, motion or dark mode (values above were collected from components), and a TDS focus-ring spec.
- The TDS Mobile UI Kit licence allows kit use only for Apps in Toss apps. This skill contains no kit parts; it re-describes publicly visible design decisions in original CSS.

## Use from the `html` skill

The two themes are registered in `ui-ux/references/index.json` as `toss-blue` and `toss-black` (`family: toss-design`). Their `path` and `tokens` fields point at this skill's `themes/<name>/design.md` and `tokens.css`; nothing is copied. `html` selects them with `design=toss-blue` or `design=toss-black` (or when the user names a Toss style), reads this SKILL.md in programmatic mode, and builds with these tokens and recipes. The ui-ux registry default stays `openai`; this skill's own default theme is `toss-blue`.
