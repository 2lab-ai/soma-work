# TDS Mobile — raw source notes (evidence file)

Captured: 2026-10-26. Author: automated extraction for the `toss-design` skill draft.

This file is the single evidence base for every value in `toss-design/`. Each section names its source URL.
Markers:

- **[observed-docs]** — seen verbatim on a TDS Mobile docs page (rendered HTML / text) at tossmini-docs.toss.im.
- **[observed-docs-css]** — seen in the docs site's shipped CSS or in the server-rendered inline styles of the docs pages (the docs render real TDS components, so inline `style=` values are the component's own values).
- **[observed-pkg]** — seen in the published npm package source (`@toss/tds-colors@0.1.0`, `@toss/tds-mobile@2.5.1`, `@toss/tds-mobile-ait@2.5.1`, read from the registry tarballs). Values only; no code is vendored into the skill.
- **[observed-ait]** — seen in the Apps in Toss developer docs (developers-apps-in-toss.toss.im, Markdown export).
- **[inferred]** — a decision made for this skill that is not stated by any source. Always says why.
- **[not found]** — looked for, not present in any source read.

---

## 0. Crawl log — every URL actually read

### 0.1 TDS Mobile docs (Nextra static site; server-rendered, so `curl -sL` returned full content)

Entry: https://tossmini-docs.toss.im/tds-mobile/ — sidebar parsed from its HTML; every sidebar link (67 pages) was downloaded and text-extracted. Pages read in detail for this skill are marked **(detail)** in section 0.2; all 67 were scanned.

- https://tossmini-docs.toss.im/tds-mobile/components/Agreement/v3/
- https://tossmini-docs.toss.im/tds-mobile/components/Agreement/v4/
- https://tossmini-docs.toss.im/tds-mobile/components/Asset/asset/
- https://tossmini-docs.toss.im/tds-mobile/components/Asset/check-first/
- https://tossmini-docs.toss.im/tds-mobile/components/Asset/frame/
- https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/Double/
- https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/Single/
- https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/check-first/
- https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/fixed-bottom-cta/
- https://tossmini-docs.toss.im/tds-mobile/components/Chart/bar-chart/
- https://tossmini-docs.toss.im/tds-mobile/components/Dialog/alert-dialog/
- https://tossmini-docs.toss.im/tds-mobile/components/Dialog/confirm-dialog/
- https://tossmini-docs.toss.im/tds-mobile/components/Dialog/dialog/
- https://tossmini-docs.toss.im/tds-mobile/components/Keypad/alphabet-keypad/
- https://tossmini-docs.toss.im/tds-mobile/components/Keypad/full-secure-keypad/
- https://tossmini-docs.toss.im/tds-mobile/components/Keypad/number-keypad/
- https://tossmini-docs.toss.im/tds-mobile/components/ListRow/ListRowLegacy/list-row-legacy/
- https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-components/
- https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-overview/
- https://tossmini-docs.toss.im/tds-mobile/components/TextField/split-text-field/
- https://tossmini-docs.toss.im/tds-mobile/components/TextField/text-area/
- https://tossmini-docs.toss.im/tds-mobile/components/TextField/text-field/
- https://tossmini-docs.toss.im/tds-mobile/components/badge/
- https://tossmini-docs.toss.im/tds-mobile/components/board-row/
- https://tossmini-docs.toss.im/tds-mobile/components/border/
- https://tossmini-docs.toss.im/tds-mobile/components/bottom-info/
- https://tossmini-docs.toss.im/tds-mobile/components/bottom-sheet/
- https://tossmini-docs.toss.im/tds-mobile/components/bubble/
- https://tossmini-docs.toss.im/tds-mobile/components/button/
- https://tossmini-docs.toss.im/tds-mobile/components/checkbox/
- https://tossmini-docs.toss.im/tds-mobile/components/grid-list/
- https://tossmini-docs.toss.im/tds-mobile/components/highlight/
- https://tossmini-docs.toss.im/tds-mobile/components/icon-button/
- https://tossmini-docs.toss.im/tds-mobile/components/list-footer/
- https://tossmini-docs.toss.im/tds-mobile/components/list-header/
- https://tossmini-docs.toss.im/tds-mobile/components/loader/
- https://tossmini-docs.toss.im/tds-mobile/components/menu/
- https://tossmini-docs.toss.im/tds-mobile/components/modal/
- https://tossmini-docs.toss.im/tds-mobile/components/numeric-spinner/
- https://tossmini-docs.toss.im/tds-mobile/components/paragraph/
- https://tossmini-docs.toss.im/tds-mobile/components/post/
- https://tossmini-docs.toss.im/tds-mobile/components/progress-bar/
- https://tossmini-docs.toss.im/tds-mobile/components/progress-stepper/
- https://tossmini-docs.toss.im/tds-mobile/components/rating/
- https://tossmini-docs.toss.im/tds-mobile/components/result/
- https://tossmini-docs.toss.im/tds-mobile/components/search-field/
- https://tossmini-docs.toss.im/tds-mobile/components/segmented-control/
- https://tossmini-docs.toss.im/tds-mobile/components/skeleton/
- https://tossmini-docs.toss.im/tds-mobile/components/slider/
- https://tossmini-docs.toss.im/tds-mobile/components/stepper/
- https://tossmini-docs.toss.im/tds-mobile/components/switch/
- https://tossmini-docs.toss.im/tds-mobile/components/tab/
- https://tossmini-docs.toss.im/tds-mobile/components/table-row/
- https://tossmini-docs.toss.im/tds-mobile/components/text-button/
- https://tossmini-docs.toss.im/tds-mobile/components/toast/
- https://tossmini-docs.toss.im/tds-mobile/components/tooltip/
- https://tossmini-docs.toss.im/tds-mobile/components/top/
- https://tossmini-docs.toss.im/tds-mobile/foundation/colors/
- https://tossmini-docs.toss.im/tds-mobile/foundation/typography/
- https://tossmini-docs.toss.im/tds-mobile/hooks/OverlayExtension/check-first/
- https://tossmini-docs.toss.im/tds-mobile/hooks/OverlayExtension/use-bottom-sheet/
- https://tossmini-docs.toss.im/tds-mobile/hooks/OverlayExtension/use-dialog/
- https://tossmini-docs.toss.im/tds-mobile/hooks/OverlayExtension/use-toast/
- https://tossmini-docs.toss.im/tds-mobile/
- https://tossmini-docs.toss.im/tds-mobile/migration/from-toss-design-system/
- https://tossmini-docs.toss.im/tds-mobile/migration/v2/
- https://tossmini-docs.toss.im/tds-mobile/start/

### 0.2 Pages read in detail

- https://tossmini-docs.toss.im/tds-mobile/ (intro) (detail)
- https://tossmini-docs.toss.im/tds-mobile/start/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/foundation/colors/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/foundation/typography/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/button/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/badge/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/border/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/paragraph/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/top/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/list-header/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-overview/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-components/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/tab/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/toast/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/skeleton/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/switch/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/checkbox/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/TextField/text-field/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/Single/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/Double/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/fixed-bottom-cta/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/Dialog/alert-dialog/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/Dialog/confirm-dialog/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/components/bottom-sheet/ (detail)
- https://tossmini-docs.toss.im/tds-mobile/migration/v2/ (detail — brand color injection)
- https://tossmini-docs.toss.im/tds-mobile/migration/from-toss-design-system/ (detail — package names)
- https://tossmini-docs.toss.im/tds-mobile/_next/static/css/586007ed2d1914fd.css (docs CSS: light `--adaptive*` tokens + body font stack)
- https://tossmini-docs.toss.im/tds-mobile/_next/static/css/445c4173ffc2bf04.css (Nextra theme CSS; nothing TDS-specific used)

### 0.3 npm package sources (registry tarballs, read for values only)

- https://registry.npmjs.org/@toss/tds-colors/-/tds-colors-0.1.0.tgz — `colors.css`, `colors.light.css`, `colors.dark.css`, `colors.scss`, `dist/esm/index.js`
- https://registry.npmjs.org/@toss/tds-mobile/-/tds-mobile-2.5.1.tgz — `dist/esm/index.js`, `dist/esm/index.d.ts`
- https://registry.npmjs.org/@toss/tds-mobile-ait/-/tds-mobile-ait-2.5.1.tgz — `dist/esm/index.js`, `TDSMobileAITProvider.d.ts`
- `npm view` metadata: `@toss/tds-mobile@2.5.1`, `@toss/tds-mobile-ait@2.5.1`, `@toss/tds-colors@0.1.0`. No `license` field in any of the three package.json files. **[observed-pkg]**

### 0.4 Apps in Toss developer docs

- https://developers-apps-in-toss.toss.im/llms.txt (index)
- https://developers-apps-in-toss.toss.im/design.md
- https://developers-apps-in-toss.toss.im/design/consumer-ux-guide.md (branding, brand color, dark patterns, UX writing, graphics, resolution)
- https://developers-apps-in-toss.toss.im/design/components.md (TDS overview + licence notice)
- https://developers-apps-in-toss.toss.im/design/prepare/figma-ui-license.md (UI Kit licence)
- https://developers-apps-in-toss.toss.im/design/prepare/design.md (design tools; skimmed)
- https://developers-apps-in-toss.toss.im/tutorials/webview.md — returned "Page Not Found" (moved). The `.html` versions of `design/ux-writing.html` and `design/miniapp-branding-guide.html` returned the SPA shell only; the same content was read from `consumer-ux-guide.md`.

---

## 1. Foundation — Colors

Source: https://tossmini-docs.toss.im/tds-mobile/foundation/colors/ **[observed-docs]**, docs CSS https://tossmini-docs.toss.im/tds-mobile/_next/static/css/586007ed2d1914fd.css **[observed-docs-css]**, dark values from `@toss/tds-colors@0.1.0/colors.dark.css` **[observed-pkg]**.

Docs text: "토스의 색상 시스템은 개발자와 디자이너가 통일된 색상 이름을 사용하도록 도와줘요." Usage: `yarn add @toss/tds-colors`, `import { colors } from '@toss/tds-colors'`, e.g. `colors.blue500`.

The docs Colors page lists light values only. It has no dark-mode section. Dark values exist only in the package (`colors.dark.css`, `darkTheme*` keys in `colors.scss`).

Scales defined by TDS: Grey, Blue, Red, Grey Opacity, Orange, Yellow, Green, Teal, Purple (each 50–900), plus background tokens. **[observed-docs]**

### 1.1 Full palette (light from docs page and docs CSS, dark from package)

Grey Opacity on the docs page is written as `#RRGGBB, alpha` (for example `#001733, 0.02`); the docs CSS writes the same values as `rgba()`.

| Token (docs name) | Light (docs Colors page) | Light (docs CSS `--adaptive*`) | Dark (`@toss/tds-colors` colors.dark.css) |
|---|---|---|---|
| `grey50` | `#f9fafb` | `#f9fafb` | `#202027` |
| `grey100` | `#f2f4f6` | `#f2f4f6` | `#2c2c35` |
| `grey200` | `#e5e8eb` | `#e5e8eb` | `#3c3c47` |
| `grey300` | `#d1d6db` | `#d1d6db` | `#4d4d59` |
| `grey400` | `#b0b8c1` | `#b0b8c1` | `#62626d` |
| `grey500` | `#8b95a1` | `#8b95a1` | `#7e7e87` |
| `grey600` | `#6b7684` | `#6b7684` | `#9e9ea4` |
| `grey700` | `#4e5968` | `#4e5968` | `#c3c3c6` |
| `grey800` | `#333d4b` | `#333d4b` | `#e4e4e5` |
| `grey900` | `#191f28` | `#191f28` | `#ffffff` |
| `blue50` | `#e8f3ff` | `#e8f3ff` | `#202c4d` |
| `blue100` | `#c9e2ff` | `#c9e2ff` | `#23386a` |
| `blue200` | `#90c2ff` | `#90c2ff` | `#25478c` |
| `blue300` | `#64a8ff` | `#64a8ff` | `#265ab3` |
| `blue400` | `#4593fc` | `#4593fc` | `#2970d9` |
| `blue500` | `#3182f6` | `#3182f6` | `#3485fa` |
| `blue600` | `#2272eb` | `#2272eb` | `#449bff` |
| `blue700` | `#1b64da` | `#1b64da` | `#61b0ff` |
| `blue800` | `#1957c2` | `#1957c2` | `#8fcdff` |
| `blue900` | `#194aa6` | `#194aa6` | `#c8e7ff` |
| `red50` | `#ffeeee` | `#fee` | `#3c2020` |
| `red100` | `#ffd4d6` | `#ffd4d6` | `#562025` |
| `red200` | `#feafb4` | `#feafb4` | `#7a242d` |
| `red300` | `#fb8890` | `#fb8890` | `#9e2733` |
| `red400` | `#f66570` | `#f66570` | `#ca2f3d` |
| `red500` | `#f04452` | `#f04452` | `#f04251` |
| `red600` | `#e42939` | `#e42939` | `#fa616d` |
| `red700` | `#d22030` | `#d22030` | `#fe818b` |
| `red800` | `#bc1b2a` | `#bc1b2a` | `#ffa8ad` |
| `red900` | `#a51926` | `#a51926` | `#ffd1d3` |
| `greyOpacity50` | `#001733, 0.02` | `rgba(0,23,51,.02)` | `rgba(209,209,253,0.05)` |
| `greyOpacity100` | `#022047, 0.05` | `rgba(2,32,71,.05)` | `rgba(217,217,255,0.11)` |
| `greyOpacity200` | `#001b37, 0.1` | `rgba(0,27,55,.1)` | `rgba(222,222,255,0.19)` |
| `greyOpacity300` | `#001d3a, 0.18` | `rgba(0,29,58,.18)` | `rgba(224,224,255,0.27)` |
| `greyOpacity400` | `#001936, 0.31` | `rgba(0,25,54,.31)` | `rgba(232,232,253,0.36)` |
| `greyOpacity500` | `#031832, 0.46` | `rgba(3,24,50,.46)` | `rgba(242,242,255,0.47)` |
| `greyOpacity600` | `#00132b, 0.58` | `rgba(0,19,43,.58)` | `rgba(248,248,255,0.6)` |
| `greyOpacity700` | `#031228, 0.7` | `rgba(3,18,40,.7)` | `rgba(253,253,255,0.75)` |
| `greyOpacity800` | `#000c1e, 0.8` | `rgba(0,12,30,.8)` | `rgba(253,253,254,0.89)` |
| `greyOpacity900` | `#020913, 0.91` | `rgba(2,9,19,.91)` | `#ffffff` |
| `orange50` | `#fff3e0` | `#fff3e0` | `#3d2500` |
| `orange100` | `#ffe0b0` | `#ffe0b0` | `#563200` |
| `orange200` | `#ffcd80` | `#ffcd80` | `#804600` |
| `orange300` | `#ffbd51` | `#ffbd51` | `#a85f00` |
| `orange400` | `#ffa927` | `#ffa927` | `#cf7200` |
| `orange500` | `#fe9800` | `#fe9800` | `#f18600` |
| `orange600` | `#fb8800` | `#fb8800` | `#fd9528` |
| `orange700` | `#f57800` | `#f57800` | `#ffa861` |
| `orange800` | `#ed6700` | `#ed6700` | `#ffc39e` |
| `orange900` | `#e45600` | `#e45600` | `#ffe4d6` |
| `yellow50` | `#fff9e7` | `#fff9e7` | `#3d2d1a` |
| `yellow100` | `#ffefbf` | `#ffefbf` | `#724c1e` |
| `yellow200` | `#ffe69b` | `#ffe69b` | `#b56f1d` |
| `yellow300` | `#ffdd78` | `#ffdd78` | `#eb8b1e` |
| `yellow400` | `#ffd158` | `#ffd158` | `#ffa126` |
| `yellow500` | `#ffc342` | `#ffc342` | `#ffb134` |
| `yellow600` | `#ffb331` | `#ffb331` | `#ffc259` |
| `yellow700` | `#faa131` | `#faa131` | `#ffd68a` |
| `yellow800` | `#ee8f11` | `#ee8f11` | `#ffe5b2` |
| `yellow900` | `#dd7d02` | `#dd7d02` | `#fff1d4` |
| `green50` | `#f0faf6` | `#f0faf6` | `#153729` |
| `green100` | `#aeefd5` | `#aeefd5` | `#135338` |
| `green200` | `#76e4b8` | `#76e4b8` | `#136d47` |
| `green300` | `#3fd599` | `#3fd599` | `#138a59` |
| `green400` | `#15c47e` | `#15c47e` | `#13a065` |
| `green500` | `#03b26c` | `#03b26c` | `#16bb76` |
| `green600` | `#02a262` | `#02a262` | `#26cf88` |
| `green700` | `#029359` | `#029359` | `#4ee4a6` |
| `green800` | `#028450` | `#028450` | `#82f6c5` |
| `green900` | `#027648` | `#027648` | `#ccffea` |
| `teal50` | `#edf8f8` | `#edf8f8` | `#203537` |
| `teal100` | `#bce9e9` | `#bce9e9` | `#224e51` |
| `teal200` | `#89d8d8` | `#89d8d8` | `#226368` |
| `teal300` | `#58c7c7` | `#58c7c7` | `#247e85` |
| `teal400` | `#30b6b6` | `#30b6b6` | `#26939a` |
| `teal500` | `#18a5a5` | `#18a5a5` | `#2eaab2` |
| `teal600` | `#109595` | `#109595` | `#43bec7` |
| `teal700` | `#0c8585` | `#0c8585` | `#65d4dc` |
| `teal800` | `#097575` | `#097575` | `#9be8ee` |
| `teal900` | `#076565` | `#076565` | `#d6fcff` |
| `purple50` | `#f9f0fc` | `#f9f0fc` | `#3f2447` |
| `purple100` | `#edccf8` | `#edccf8` | `#522361` |
| `purple200` | `#da9bef` | `#da9bef` | `#66247b` |
| `purple300` | `#c770e4` | `#c770e4` | `#7b2595` |
| `purple400` | `#b44bd7` | `#b44bd7` | `#962fb5` |
| `purple500` | `#a234c7` | `#a234c7` | `#ae3dd1` |
| `purple600` | `#9128b4` | `#9128b4` | `#c353e5` |
| `purple700` | `#8222a2` | `#8222a2` | `#d77cf2` |
| `purple800` | `#73228e` | `#73228e` | `#eaacfc` |
| `purple900` | `#65237b` | `#65237b` | `#f6d9ff` |
| `background` | `#FFFFFF` | `#fff` | `#17171c` |
| `greyBackground` | `lightThemeGrey100` | `#f2f4f6` | `#101013` |
| `layeredBackground` | `#FFFFFF` | `#fff` | `#202027` |
| `floatedBackground` | `#FFFFFF` | `-` | `-` |

### 1.2 Other adaptive tokens (docs CSS light vs package dark)

| CSS variable | Light (docs CSS) | Dark (package) |
|---|---|---|
| `--adaptiveBackgroundDimmed` | `rgba(0,0,0,.2)` | `rgba(0,0,0,0.56)` |
| `--adaptiveBackgroundLevel01` | `#fff` | `#202027` |
| `--adaptiveBackgroundLevel02` | `#fff` | `#2c2c35` |
| `--adaptiveBackgroundLevelB01` | `#f2f4f6` | `#101013` |
| `--adaptiveDimmedBackground` | `rgba(0,0,0,.2)` | `rgba(0,0,0,0.56)` |
| `--adaptiveDisabledBlue500` | `#c9e2ff` | `rgba(49,130,246,0.2)` |
| `--adaptiveFloatBackground` | `#fff` | `#2c2c35` |
| `--adaptiveHairlineBorder` | `#e5e8eb` | `#3c3c47` |
| `--adaptiveOpacity100` | `rgba(2,32,71,.05)` | `rgba(217,217,255,0.11)` |
| `--adaptiveOpacity200` | `rgba(0,27,55,.1)` | `rgba(222,222,255,0.19)` |
| `--adaptiveOpacity300` | `rgba(0,29,58,.18)` | `rgba(224,224,255,0.27)` |
| `--adaptiveOpacity400` | `rgba(0,25,54,.31)` | `rgba(232,232,253,0.36)` |
| `--adaptiveOpacity50` | `rgba(0,23,51,.02)` | `rgba(209,209,253,0.05)` |
| `--adaptiveOpacity500` | `rgba(3,24,50,.46)` | `rgba(242,242,255,0.47)` |
| `--adaptiveOpacity600` | `rgba(0,19,43,.58)` | `rgba(248,248,255,0.6)` |
| `--adaptiveOpacity700` | `rgba(3,18,40,.7)` | `rgba(253,253,255,0.75)` |
| `--adaptiveOpacity800` | `rgba(0,12,30,.8)` | `rgba(253,253,254,0.89)` |
| `--adaptiveOpacity900` | `rgba(2,9,19,.91)` | `rgba(255,255,255,1)` |
| `--adaptivePcScreenBg` | `-` | `#202027` |

### 1.3 Static colours in the component bundle **[observed-pkg]** (`@toss/tds-mobile@2.5.1`)

- `white` `#ffffff`, `black` `#000000` (`@toss/tds-colors` `colors.css`).
- whiteOpacity scale: 50 `rgba(209,209,253,0.05)`, 100 `rgba(217,217,255,0.11)`, 200 `rgba(222,222,255,0.19)`, 300 `rgba(224,224,255,0.27)`, 400 `rgba(232,232,253,0.36)`, 500 `rgba(242,242,255,0.47)`, 600 `rgba(248,248,255,0.6)`, 700 `rgba(253,253,255,0.75)`, 800 `rgba(253,253,254,0.89)`, 900 `rgba(255,255,255,1)`.
- Component "t" tokens `[light, dark]`:
  - `tHairlineBackground`: a 1px-tall `repeat-x` SVG with a 0.5px rect filled `rgba(0, 0, 33, 0.07)` (light) / `rgba(222, 222, 255, 0.14)` (dark). This is the TDS hairline divider.
  - `tToastBackground`: `rgba(25,31,40,0.54)` / `rgba(217,217,255,0.11)` (token exists; the 2.5.1 Toast component itself paints `white`, see 3.9).
  - `tDarkFillButtonBackground`: `#4e5968` (grey700).
  - `tPrimaryWeakButtonBackground` `#e8f3ff`; `tDangerWeakButtonBackground` `#ffeeee`; `tDarkWeakButtonBackground` `#f2f4f6`; `tLightWeakButtonBackground` `rgba(222,222,255,0.19)`.
  - `tButtonPressedAfterBackground`: `transparent` / `rgba(0, 0, 0, 0.26)`.
  - `tPrimaryWeakButtonPressedBackground` `rgba(49,130,246,0.26)`; `tDangerWeakButtonPressedBackground` `rgba(244,67,54,0.26)`; `tDarkWeakButtonPressedBackground` `rgba(78,89,104,0.26)`; `tLightWeakButtonPressedBackground` `rgba(255,255,255,0.26)`.
  - Badge weak text / background (light | dark):
    - blue: `#1b64da` on `rgba(49,130,246,0.16)` | `#4593fc` on `rgba(69,147,252,0.16)`
    - teal: `#0c8585` on `rgba(0,129,138,0.16)` | `#30b6b6` on `rgba(38,157,166,0.16)`
    - green: `#029359` on `rgba(2,162,98,0.16)` | `#15c47e` on `rgba(21,196,126,0.16)`
    - red: `#d22030` on `rgba(244,67,54,0.16)` | `#f66570` on `rgba(239,83,80,0.16)`
    - yellow: `#dd7d02` on `rgba(255,179,49,0.16)` | `#faa131` on `rgba(255,209,88,0.16)`
    - elephant: `#4e5968` on `rgba(78,89,104,0.16)` | (dark text token unresolved) on `rgba(195,195,198,0.16)`
  - `tSwiperBulletBackground`: `rgba(232,232,253,0.36)` / `rgba(0,25,54,0.31)`.
  - `tListRowDisabledBackground`: `rgba(253,253,255,0.75)` / `rgba(23,23,28,0.7)`.
  - `tGradientToBottom` (docs CSS light): `linear-gradient(180deg,#fff,hsla(0,0%,100%,0))`; `tRadioIndicatorBackgroundColor` light `#fff`.

### 1.4 Verified brand values

- **Toss Blue = `blue500` = `#3182f6`** **[observed-docs]** (Colors page), also `--adaptiveBlue500:#3182f6` **[observed-docs-css]**, and the AIT example `#3182F6` **[observed-ait]**. Dark-mode blue500 is `#3485fa` **[observed-pkg]**.
- **Toss near-black = `grey900` = `#191f28`** **[observed-docs]**. Dark-mode grey900 is `#ffffff` **[observed-pkg]**.

---

## 2. Foundation — Typography

Source: https://tossmini-docs.toss.im/tds-mobile/foundation/typography/ **[observed-docs]**; resolved CSS variables in that page's inline `:root` style **[observed-docs-css]**.

Docs text (summary): typography tokens are hierarchical; don't hard-code the px values ("아래 표에 나온 값을 직접 하드코딩하지 않길 권장해요"), because "더 큰 텍스트" (iOS/Android larger-text accessibility setting) must be honoured in web views too.

### 2.1 Token table (100% / default text size)

| Token | CSS alias | font-size | line-height | Usage (docs, Korean) |
|---|---|---|---|---|
| Typography 1 | `t1` → `f30` | 30px | 40px | 매우 큰 제목 (very large title) |
| sub Typography 1 | `st1` → `f29` | 29px | 38px | |
| sub Typography 2 | `st2` → `f28` | 28px | 37px | |
| sub Typography 3 | `st3` → `f27` | 27px | 36px | |
| Typography 2 | `t2` → `f26` | 26px | 35px | 큰 제목 (large title) |
| sub Typography 4 | `st4` → `f25` | 25px | 34px | |
| sub Typography 5 | `st5` → `f24` | 24px | 33px | 조금 큰 제목 (slightly large title) |
| sub Typography 6 | `st6` → `f23` | 23px | 32px | |
| Typography 3 | `t3` → `f22` | 22px | 31px | 일반 제목 (normal title) |
| sub Typography 7 | `st7` → `f21` | 21px | 30px | |
| Typography 4 | `t4` → `f20` | 20px | 29px | 작은 제목 (small title) |
| sub Typography 8 | `st8` → `f19` | 19px | 28px | 조금 큰 본문 (slightly large body) |
| sub Typography 9 | `st9` → `f18` | 18px | 27px | |
| Typography 5 | `t5` → `f17` | 17px | 25.5px | 일반 본문 (normal body) |
| sub Typography 10 | `st10` → `f16` | 16px | 24px | |
| Typography 6 | `t6` → `f15` | 15px | 22.5px | 작은 본문 (small body) |
| sub Typography 11 | `st11` → `f14` | 14px | 21px | |
| Typography 7 | `t7` → `f13` | 13px | 19.5px | 안 읽어도 됨 (OK to skip) |
| sub Typography 12 | `st12` → `f12` | 12px | 18px | |
| sub Typography 13 | `st13` → `f11` | 11px | 16.5px | 아예 안읽어도 됨 (fine to skip entirely) |

The aliases (`--tds-t-t1-text-fontSize: var(--tds-t-f30-text-fontSize)` etc.) are **[observed-docs-css]**.

### 2.2 Font weights

The "전체 보기" grid shows five weight rows: Light, Regular, Medium, Semibold, Bold. In markup, Regular = `400`, Medium = `500`, Semibold = `600`, Bold = `700` **[observed-docs-css]** (`--tds-paragraph-font-weight`). Light has no explicit weight in the markup (inherits) → **Light numeric weight: [not found]**. `Paragraph` `fontWeight` prop accepts only `regular | medium | semibold | bold` (default `regular`) **[observed-docs]**.

### 2.3 Line-height helpers **[observed-pkg]**

`line-height-xs: 1.252` (Button, Tab), `line-height-s: 1.35` (ListRow texts and TextButton inside ListRow), `line-height-m: 1.5`. `ListRow.Texts` computes typography with a 1.35 multiplier (`CS=1.35`). Badge uses `line-height: 1.5em`.

### 2.4 f-scale extras (per-size badge / icon / link metrics) **[observed-docs-css]**

| f | text | line-height | icon-height | badge font | badge padding | badge radius |
|---|---|---|---|---|---|---|
| f11 | 11px | 16.5px | 12px | 9px | 3px 6px | 8px |
| f12 | 12px | 18px | 13px | 9px | 3px 6px | 8px |
| f13 | 13px | 19.5px | 14px | 9px | 3px 6px | 8px |
| f14 | 14px | 21px | 15px | 10px | 3px 7px | 9px |
| f15 | 15px | 22.5px | 17px | 10px | 3px 7px | 9px |
| f16 | 16px | 24px | 18px | 10px | 3px 7px | 9px |
| f17 | 17px | 25.5px | 19px | 10px | 3px 7px | 9px |
| f18 | 18px | 27px | 20px | 11px | 3px 7px | 10px |
| f19 | 19px | 28px | 21px | 11px | 3px 7px | 10px |
| f20 | 20px | 29px | 22px | 11px | 3px 7px | 10px |
| f21 | 21px | 30px | 24px | 11px | 3px 7px | 10px |
| f22 | 22px | 31px | 25px | 12px | 3px 7px | 11px |
| f23 | 23px | 32px | 26px | 12px | 3px 7px | 11px |
| f24 | 24px | 33px | 27px | 12px | 3px 7px | 11px |
| f25 | 25px | 34px | 28px | 12px | 3px 7px | 11px |
| f26 | 26px | 35px | 29px | 13px | 3px 7px | 12px |
| f27 | 27px | 36px | 31px | 13px | 3px 7px | 12px |
| f28 | 28px | 37px | 32px | 13px | 3px 7px | 12px |
| f29 | 29px | 38px | 33px | 13px | 3px 7px | 12px |
| f30 | 30px | 40px | 34px | 14px | 4px 8px | 13px |
| f31–f42 | 31–42px | 41–52px | 35–48px | 14–16px | 4px 8px → 5px 10px | 13–14px |

Link metrics: `link-horizontalPadding` 4px (f11–f18) / 5px (f19+); `link-borderRadius` 4px / 5px; underline thickness light 0.7px (≤f15), 1px (f16–f18), 1.3px (f19+); bold 1px / 1.3px / 1.5px.

### 2.5 Larger text (더 큰 텍스트) **[observed-docs]**

iOS steps: Large 100%, xLarge 110%, xxLarge 120%, xxxLarge 135%, A11y_Medium 160%, A11y_Large 190%, A11y_xLarge 235%, A11y_xxLarge 275%, A11y_xxxLarge 310%. Example row: Typography 1 → 30, 32, 34, 36, 40, 41, 41, 42, 42. Typography 5 → 17, 19, 21, 23, 27, 32, 36, 38, 39. Typography 7 → 13, 15, 17, 19, 21, 24, 27, 30, 34.
Android: `size × NN × 0.01`, capped. Caps: t1/st1 42; st2/st3/t2/st4 41; st5/st6/t3/st7/t4/st8 40; st9/t5/st10 39; t6 37; st11 36; t7 34; st12 32; st13 31.
`TDSMobileAITProvider` prop `fontScaleAvailable` defaults to `false` ("더큰텍스트 지원 여부. 기본값은 false로 더큰텍스트 설정을 따르지 않아요") **[observed-pkg]**.

### 2.6 Font family

- Docs site body font stack **[observed-docs-css]**: `Toss Product Sans, Tossface, SF Pro KR, SF Pro Display, SF Pro Icons, -apple-system, BlinkMacSystemFont, Basier Square, Apple SD Gothic Neo, Roboto, Noto Sans KR, Noto Sans, Helvetica Neue, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji`.
- No public download, licence or `@font-face` for Toss Product Sans was found in any source → **Toss Product Sans licence / distribution: [not found]**; treat as proprietary. **[inferred]**
- Pretendard is not mentioned by TDS. Its use here is a skill decision **[inferred]** (SIL OFL 1.1 font; jsDelivr `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css` returned HTTP 200 on 2026-10-26).

---

## 3. Components

### 3.1 Button — https://tossmini-docs.toss.im/tds-mobile/components/button/

Docs **[observed-docs]**: props `color: primary | danger | light | dark` (default `primary`), `variant: fill | weak` (default `fill`), `display: inline | block | full` (default `inline`), `size: small | medium | large | xlarge` (default `xlarge`), `loading`, `disabled`, `as: button | a`. `fill` = "채도가 높아 … 주요 액션을 강조"; `weak` = "채도가 낮아 … 덜 중요한 액션이나 보조적인 버튼 … 반투명하게 디자인되어 배경색이 살짝 드러나는 모습". Loading = 3 dots animate in sequence, width does not change. CSS vars: `--button-color`, `--button-background-color`, `--button-disabled-opacity-color`, `--button-disabled-text-opacity`, `--button-gradient-color`, `--button-loader-color`, `--button-loading-background-color`, `--button-loading-opacity`, `--button-pressed-background-color`, `--button-pressed-opacity`. Accessibility: `aria-busy` while loading; icon-only buttons need `aria-label`.

Sizes **[observed-pkg]** (`x$e` table), confirmed by docs inline styles for xlarge and medium **[observed-docs-css]**:

| size | font | radius | min-width | min-height | padding | loader dot / gap |
|---|---|---|---|---|---|---|
| xlarge | t5 (17px) | 16px | 96px | 56px | `2px 28px` (inline display: `15px 28px`) | 8px / 7px |
| large | t5 (17px) | 14px | 80px | 48px | `2px 16px` | 8px / 5px |
| medium | t6 (15px) | 10px | 64px | 38px | `2px 16px` | 5px / 4px |
| small | t7 (13px) | 8px | 52px | 32px | `2px 10px` | 5px / 3px |

`display: block` → `display:flex; width:100%`; `display: full` → width 100% and radius `0px`. Font weight `600`, `line-height: 1.252`, `-webkit-font-smoothing: antialiased`, `white-space: nowrap`. Transition `color/background-color/border-color/box-shadow/opacity 0.1s ease-in-out`.

Colours per `color` × `variant` (default theme, light) **[observed-pkg]** (`j3e`), confirmed by docs inline styles **[observed-docs-css]**:

| color | fill bg | fill text | weak bg | weak text |
|---|---|---|---|---|
| primary | blue500 `#3182f6` | whiteOpacity900 (`rgba(255,255,255,1)`) | blue300 @ 0.15 → `rgba(100,168,255,0.15)` | blue600 `#2272eb` |
| danger | red500 `#f04452` | white | red300 @ 0.15 → `rgba(251,136,144,0.15)` | red600 `#e42939` |
| dark | grey700 `#4e5968` | white | greyOpacity100 `rgba(2,32,71,0.05)` | grey700 `#4e5968` |
| light | whiteOpacity900 | blue700 `#1b64da` | whiteOpacity200 | whiteOpacity900 |

Dark scheme: primary weak = blue600 @ 0.22 with blue400 text; danger weak = red600 @ 0.22 with red400 text.

Pressed / loading **[observed-pkg]**: pressed → `scale: 0.96` (spring `rapid`) unless `display="full"` (scale 1); a dim layer animates to `opacity: 0.26` with `--button-dimmer-pressed-background-color` (`rgb(0,0,0)` for fill primary; `#4e5968` for dark weak; brand-derived otherwise). Loading → dim `opacity: 0.13` with `--button-dimmer-loading-background-color` (pressed colour at alpha 0.26) and a radial gradient pulse (`--button-gradient-color`, primary fill: `rgba(0, 89, 195, 1)` observed in docs inline style) at opacity 0→0.7 (fill) / 0→0.24 (weak), `ease out`, 0.6s, infinite reverse; three dots scale 0.8→1, opacity 0.2→1, 0.3s, staggered 0.1s. Disabled → container opacity 0.3 (fill) / 1 (weak); label opacity 1 (fill) / 0.3 (weak).

### 3.2 Brand-primary derivation for Button (the native theming mechanism) **[observed-pkg]**

`TDSMobileProvider` / `ThemeProvider` accept `token={{ color: { primary } }}` (`SeedToken = { color: { primary: string } }`, `DerivedToken = { button: { fill, weak } }`). When `primary` ≠ blue500, Button colour `primary` is derived from the brand colour by OKLCH lightness `L` (function `bV`):

| brand L (OKLCH) | fill bg | fill text | weak bg | weak text |
|---|---|---|---|---|
| L < 0.40 | brand as-is | `#fff` | grey700 @ 0.07 | grey700 |
| 0.40 ≤ L ≤ 0.525 | brand | `#fff` | brand @ 0.08 | brand |
| 0.525 < L ≤ 0.645 | brand | `#fff` | brand @ 0.09 | brand at L 0.525 |
| 0.645 < L < 0.70 | brand at L 0.645 | `#fff` | brand @ 0.11 | brand at L 0.525 |
| 0.70 ≤ L ≤ 0.75 | brand at L 0.645 | `#fff` | brand @ 0.13 | brand at L 0.525 |
| 0.75 < L < 0.80 | brand at L 0.645 | `#fff` | brand @ 0.15 | brand at L 0.525 |
| L ≥ 0.80 | brand | greyOpacity800 | grey700 @ 0.07 | grey700 |

Fill gradient colour = brand with lightness −0.134; pressed dim = `rgb(0,0,0)` (or `rgba(0,0,0,0.5)` when L ≥ 0.8); loader `#fff` (or greyOpacity600). Weak dim/gradient/loader for L < 0.4 = grey700.

`#191f28` has OKLCH L ≈ 0.23 (< 0.40), so TDS itself would render `brandPrimaryColor="#191F28"` as: fill `#191f28` + white text; weak `rgba(78,89,104,0.07)` + grey700 text. **[observed-pkg rule; numeric L computed for this skill]**

Scope of the mechanism: `deriveToken` returns only `button`. Switch (blue500 → pressed blue700), Checkbox (blue500), Badge `blue`, `Paragraph.Link` (default blue500), `ListRow.AssetText` (blue500), TextField focus (blue600 label, blue900 overlay, blue400 underline) are hard-coded to blue in 2.5.1 and do **not** follow the brand colour. **[observed-pkg]**

`TDSMobileAITProvider` (Apps in Toss wrapper) **[observed-pkg]**: prop `brandPrimaryColor?: string` — "브랜드 기본 색상. 별도로 지정하지 않은 경우 granite.config.ts에 정의된 브랜드 기본 색상을 사용해요." Implementation: `brandPrimaryColor ?? getAppsInTossGlobals().brandPrimaryColor ?? blue500`, passed as `token: { color: { primary } }`. It also forces `colorPreference: "light"`.

Docs **[observed-docs]** (migration/v2): "이제 버튼 색상들을 일괄로 변경할 수 있도록 brandColor를 주입 받는 것 또한 가능해요. bedrock.config.ts에 명시한 primaryColor가 버튼의 배경색으로 일괄 변경됩니다."

Apps in Toss **[observed-ait]** (consumer-ux-guide.md, "브랜드 컬러"): brand colour is used at Toss entry points, the bridge screen and buttons (when TDS is used). Rules: use the existing brand colour; otherwise the most-used logo colour; "브랜드 컬러가 색 대비 기준을 충족하지 못하면, 기존 색상을 최대한 유지하면서 자동으로 보정돼요". Config: SDK 2.x `granite.config.ts` → `brand.primaryColor`; SDK 3.x `apps-in-toss.config.ts` → `defineConfig({ brand: { primaryColor: '#3182F6' } })`; six-digit hex with `#`.

### 3.3 BottomCTA / FixedBottomCTA — https://tossmini-docs.toss.im/tds-mobile/components/BottomCTA/Single/ , …/Double/ , …/fixed-bottom-cta/

Docs **[observed-docs]**: `BottomCTA.Single` (one button), `BottomCTA.Double` (`leftButton`, `rightButton`); `background` default on (`none` removes it); `hasSafeAreaPadding` (default true) adds `--toss-safe-area-bottom`; `hasPaddingBottom` false → 0; safe-area off → paddingBottom 20px; `fixed` = FixedBottomCTA; `hideOnScroll`; `showAfterDelay {animation: slide|fade|scale, delay}`; `fixedAboveKeyboard` (Single only); avoid changing `opacity`/`bottom` while the keypad is up.
Inline styles **[observed-docs-css]**: wrapper `--bottom-cta-background: var(--adaptiveBackground)`, `--bottom-cta-padding: 0 20px 20px 20px`, `--bottom-cta-padding-bottom: max(var(--toss-safe-area-bottom, 0px), env(safe-area-inset-bottom), 20px)`, a 36px-tall fade strip above with `--bottom-cta-gradient: linear-gradient(to top, #ffffff 25%, rgba(255,255,255,0))`. Button is xlarge, `display:flex; width:100%`, radius 16px, min-height 56px. Double: `flex-wrap: wrap-reverse; gap: 8px` (fallback margin 8px), each child `min-width: calc(50% - gap)`; in the docs sample the left button is `dark` + `weak` (`greyOpacity100` bg, `grey700` text) and the right button primary fill.

### 3.4 Top — https://tossmini-docs.toss.im/tds-mobile/components/top/

Docs **[observed-docs]**: page-top title area (not a navigation bar). Props: `title*`, `upperGap` 24, `lowerGap` 24, `upper`, `lower`, `subtitleTop`, `subtitleBottom`, `right`, `rightVerticalAlign center|end`. `Top.TitleParagraph`: size 22 (t3) or 28 (st2), colour `adaptive.grey800`, weight `bold`. `Top.SubtitleParagraph`: size 13/15/17 → t7/t6/t5, colour `adaptive.grey700`, weight regular/regular/medium. `Top.LowerButton` default size `small`; `Top.LowerCTAButton` default `large`; `Top.RightButton` default `medium`; `Top.RightArrow` icon `icon-arrow-right-small-mono`, `adaptive.grey600`. Accessibility: title `role="heading" aria-level="1"`, subtitle `aria-level="2"`, selectors `aria-haspopup="listbox"`.
Inline CSS **[observed-docs-css]**: container `padding-top: var(--upper-gap); padding-bottom: var(--lower-gap)`; content `padding-left: 24px`; subtitle wrapper `padding-top: 4px`; title/right gap `8px`; upper asset `margin-bottom: 16px`; right button margin `0 24px 0 8px`.

### 3.5 TopNavigation (package only) **[observed-pkg]**

Not in the docs sidebar as of 2026-10-26 → docs page **[not found]**. The package exports `TopNavigation`, `TopNavigationBackButton`, `TopNavigationIconButton`, `TopNavigationTextButton`, `useTopNavigationHeight`. Height: iOS `var(--toss-top-navigation-height, 44px)`, Android `var(--toss-top-navigation-height, 54px)` (+ top inset when `withSafeAreaTop`). Back icon `icon-system-arrow-back-ios-outlined` / `-android-outlined`, colour grey900. Text button: grey700, semibold, height 40, min-width 48, padding 0 8px; red dot 7px red500. Apps in Toss **[observed-ait]**: "내비게이션 바는 화면 상단에 고정되는 영역으로, 앱인토스 전용 컴포넌트를 제공해요."

### 3.6 ListHeader — https://tossmini-docs.toss.im/tds-mobile/components/list-header/

Docs **[observed-docs]**: `title*` (`ListHeader.TitleParagraph` typography `t7|t5|t4`, weight `bold|medium|regular`, colour `adaptive.grey800`; or `TitleTextButton`, `TitleSelector`), `titleWidthRatio` 0.66, `description` (`ListHeader.DescriptionParagraph`), `descriptionPosition top|bottom` (default top), `right` (`RightText` typography `t7|t6` colour grey700; `RightArrow` arrow grey400, text grey700), `rightAlignment center|bottom`.
Inline CSS **[observed-docs-css]**: container `padding: 24px 0 8px`; title column `padding-left: 24px`, width 66%; description `padding: 0 24px`, t7, grey600; right `margin-right: 24px`, t7 grey700; sample title t5 bold grey800 with `role="heading" aria-level="2"`.

### 3.7 ListRow — https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-overview/ , …/list-row-components/

Docs **[observed-docs]**: areas `left` / `contents` / `right`; `border: indented | none` (overview says default `indented`; the 2.5.1 source default is `none` **[observed-pkg]**); `verticalPadding` small 8px / medium 12px (default) / large 16px / xlarge 24px; `horizontalPadding` small 20px / medium 24px (default); `disabledStyle type1|type2`; `withArrow`; `withTouchEffect` (auto when `onClick`); `shine` / `blink` emphasis; `ListRow.Loader` (`square|circle|bar`).
Assets: `ListRow.AssetIcon` shapes `original|squircle|card|circle-background|circle-masking`, sizes xsmall/small/medium (fill sizes 24/30/36 **[observed-pkg]**); `AssetImage` `square` 52×52, `circle` 40×40, `original` image height 56, 2D emoji 24, 3D emoji 40; `AssetText` default colour `adaptive.blue500` on `adaptive.greyOpacity100`; `IconButton` variants `fill|clear|border`, `bgColor` greyOpacity100, `iconSize` 24.
Structure **[observed-pkg]**: row `display:flex; min-height: 44px`; hairline `::before` at top, `margin-left: 24px; width: calc(100% - 24px); height: 1px; background: tHairlineBackground` when `indented`; content padding `var(--list-row-vertical-padding,12px) var(--list-row-horizontal-padding,24px)`; left gap 12px (when left exists); gap 16px; touch effect layer `greyOpacity100`, radius 12px; arrow `icon-arrow-right-mono` 24×24 grey400, `margin-left: 4px; margin-right: -8px`.

`ListRow.Texts` presets **[observed-pkg]** (typography / colour / weight):

| type | top | middle | bottom |
|---|---|---|---|
| 1RowTypeA | t5 grey700 medium | | |
| 1RowTypeB | t5 grey800 semibold | | |
| 1RowTypeC | t5 grey800 bold | | |
| Right1RowTypeA | t5 grey800 regular | | |
| Right1RowTypeB | t5 grey800 medium | | |
| Right1RowTypeC | t6 grey600 regular | | |
| Right1RowTypeD | t7 grey600 regular | | |
| Right1RowTypeE | t5 grey800 bold | | |
| 2RowTypeA | t5 grey800 bold | | t6 grey600 regular |
| 2RowTypeB | t4 grey800 semibold | | t6 grey600 regular |
| 2RowTypeC | t5 grey800 bold | | t7 grey600 medium |
| 2RowTypeD | t6 grey600 regular | | t5 grey800 bold |
| 2RowTypeE | t6 grey600 regular | | t4 grey800 semibold |
| 2RowTypeF | t7 grey600 medium | | t5 grey800 bold |
| Right2RowTypeA | t5 grey800 bold | | t6 grey600 regular |
| Right2RowTypeB | t5 grey800 bold | | t7 grey600 regular |
| Right2RowTypeC | t6 grey600 regular | | t6 grey600 regular |
| Right2RowTypeD | t7 grey600 regular | | t5 grey800 bold |
| Right2RowTypeE | t6 grey600 regular | | t5 grey800 bold |
| 3RowTypeA | t5 grey800 bold | t7 grey600 medium | t7 grey600 medium |
| 3RowTypeB | t4 grey800 semibold | t6 grey600 regular | t6 grey600 regular |
| 3RowTypeC | t7 grey600 medium | t5 grey800 bold | t7 grey600 medium |
| 3RowTypeD | t6 grey600 regular | t4 grey800 semibold | t6 grey600 regular |
| 3RowTypeE | t7 grey600 medium | t7 grey600 medium | t5 grey800 bold |
| 3RowTypeF | t6 grey600 regular | t6 grey600 regular | t4 grey800 semibold |

### 3.8 Badge — https://tossmini-docs.toss.im/tds-mobile/components/badge/

Docs **[observed-docs]**: `variant* fill|weak`, `size* xsmall|small|medium|large`, `color* blue|teal|green|red|yellow|elephant`. Purpose: "항목의 상태를 빠르게 인식할 수 있도록 강조".
**[observed-pkg]**: size → typography/weight: xsmall t5 / 600, small t3 / 700, medium t2 / 700, large t1 / 700 — the badge uses that typography's *badge* metrics (2.4): xsmall 10px, pad 3px 7px, radius 9px; small 12px, 3px 7px, 11px; medium 13px, 3px 7px, 12px; large 14px, 4px 8px, 13px. `line-height: 1.5em`, inline-flex, centred.
Fill colours: blue `#fff` on blue500; teal `#fff` on teal600; green `#fff` on green600; red `#fff` on red500; yellow grey800 on yellow500; elephant `#fff` on grey700. Weak colours: see 1.3. Docs inline style **[observed-docs-css]** confirms medium blue fill: `color:#ffffff; background-color:#3182f6; font-weight:700`, font `var(--tds-t-t2-badge-fontSize)`.

### 3.9 Toast — https://tossmini-docs.toss.im/tds-mobile/components/toast/

Docs **[observed-docs]**: `position* top|bottom`, `text*`, `leftAddon` (`Toast.Icon`, `Toast.Lottie`), `button` (bottom only), `duration` 3000ms (5000ms with button), `higherThanCTA`, `aria-live` default `polite`.
**[observed-pkg]**: container `position: fixed; left: 50%; transform: translateX(-50%); z-index: 30000`; box `width: max-content; max-width: min(375px, calc(100vw - 36px)); margin: 0 18px; box-shadow: 0 2px 30px greyOpacity200; radius 100px (single line) / 20px (multi-line)`; inner padding `12px 16px` (with addon `12px 16px 12px 12px`); light: background `white`, text greyOpacity800; dark: background darkTheme grey200, text white; text t6 semibold; addon 24×24 with 8px right margin.

### 3.10 Dialog (AlertDialog / ConfirmDialog) — https://tossmini-docs.toss.im/tds-mobile/components/Dialog/alert-dialog/ , …/confirm-dialog/

Docs **[observed-docs]**: Alert = `title`, `description`, `alertButton`; Confirm = `title`, `description`, `cancelButton`, `confirmButton`; `closeOnDimmerClick` default true (false → wiggle animation); long descriptions scroll; long button labels stack vertically full-width.
**[observed-pkg]**: dim `background: rgba(0,0,0)` at opacity 0.2 (light) / 0.56 (dark), z-index 10000, fades in with `quick`, out with `rapid`; box `position: fixed; top/left 50%; translate(-50%,-50%); width: calc(100vw - 64px); max-width: 320px; max-height: calc(100vh - 160px); background: floatBackground; border-radius: 24px`. Body `display:flex; flex-direction:column; gap: 8px; padding: 22px 22px 0`; title t4, bold, grey800, line-height 1.35; description t6, medium, grey600, line-height 1.5. ConfirmDialog footer `margin: 20px 16px 16px; gap: 8px; flex-wrap: wrap-reverse`, each button `min-width: calc(50% - 8px)`; cancel button default = `color="dark" variant="weak" size="large"`, confirm = primary fill `size="large"`. AlertDialog footer `display:flex; justify-content:flex-end; margin: 14px 16px 16px`, alert button `padding: 6px 12px; text-align: right` (text-style button).
UX writing **[observed-ait]**: "다이얼로그 왼쪽 버튼은 닫기로 문구를 통일해요. 취소는 … 오해할 수 있어 쓰지 않아요."

### 3.11 BottomSheet — https://tossmini-docs.toss.im/tds-mobile/components/bottom-sheet/

Docs **[observed-docs]**: `header` (`BottomSheet.Header`), `headerDescription`, `cta` (`BottomSheet.CTA`), `BottomSheet.DoubleCTA`, `BottomSheet.Select`, `disableDimmer`, `UNSAFE_disableFocusLock`, `hasTextField`.
**[observed-pkg]**: sheet `width: calc(100% - 20px); background: layeredBackground; border-radius: 28px; overflow: hidden` (floating, inset 10px from each side); handle area 16px tall with a 48×4px bar; header padding `21px 0 13px`; content bottom padding 16px with a 16px `tLayeredGradientToTop` fade above the CTA; drag down ≥ 50px closes.

### 3.12 Tab — https://tossmini-docs.toss.im/tds-mobile/components/tab/

Docs **[observed-docs]**: `size large|small` (default large), `fluid` (scroll; recommended when > 4 items), `itemGap`, `Tab.Item selected`, `redBean`; ARIA `tablist` / `tab` / `aria-selected`.
**[observed-pkg]**: container background `background`, bottom hairline `::after` (tHairlineBackground, 1px); item `min-width: 64px; color: grey600; transition: color 0.3s ease`; label weight **700 selected / 600 unselected**, colour **grey800 selected / grey600 unselected**; indicator `height: 2px; padding: 0 10px; ::after background grey800; border-radius: 1px`, moves with spring `quick`; press → scale 0.96 (`rapid`). Size table: large full → left/right padding 20px, item padding `0 8px`, title padding `12px 0 14px`, t5; small full → title padding `8px 0`, t6; fluid → left 14px, item padding `0 12px` (large) / `0 8px` (small). Red bean: 6×6px, `#f44336`, radius 3px, top 4px.
Note: TDS's own active-tab indicator is near-black (grey800), not blue. **[observed-pkg]**

### 3.13 TextField — https://tossmini-docs.toss.im/tds-mobile/components/TextField/text-field/

Docs **[observed-docs]**: `variant box|line|big|hero`; `hasError`, `disabled`, `labelOption appear|sustain`, `prefix`, `suffix`, `right`, `help`; `TextField.Clearable`, `TextField.Password`, `TextField.Button`.
**[observed-pkg]**: container font per variant — box t5 (children padding `0 20px`), line t3, big t1, hero t1 (padding `0 24px`). Label t7, `padding: 0 24px 6px`, colour grey800 (normal) / blue600 (focused) / red600 (error). Help t7, `padding: 6px 24px 0`, grey600 / red600 (error). Box field: `border-radius: 14px; border: 1px solid greyOpacity100; padding: 14px 16px; background: greyOpacity50`; text grey800, placeholder grey500; focus overlay blue900 at opacity 0.05, error overlay red900 at 0.05 (`transition: background-color 0.2s ease, opacity 0.2s ease`); disabled background grey200, text grey400. Line/big field: `border-bottom: 2px solid` grey100 → blue400 (focused) → red600 (error); weight 600; `padding: 0 0 4px`.

### 3.14 Switch — https://tossmini-docs.toss.im/tds-mobile/components/switch/

Docs **[observed-docs]**: `checked`, `disabled`, `hasTouchEffect` (default true); `role="switch"`, `aria-checked`; label must not contain "스위치/켜짐/꺼짐".
**[observed-pkg]** + docs inline style: track 50×30px, radius 15px; checked bg blue500 (pressed blue700), unchecked grey200 (pressed grey400); knob white, 24px checked / 16px unchecked, `left: 7px`, `translateX(16px)` when on; disabled opacity 0.3; press scale 0.96; wiggle on disabled tap.

### 3.15 Checkbox — https://tossmini-docs.toss.im/tds-mobile/components/checkbox/

Docs **[observed-docs]**: `Checkbox.Circle`, `Checkbox.Line`; `inputType checkbox|radio`; disabled tap → side-to-side shake; `aria-label` required (do not include the word "체크박스").
**[observed-pkg]**: checked fill blue500, unchecked grey200; press scale 0.9 with greyOpacity100 layer.

### 3.16 Skeleton — https://tossmini-docs.toss.im/tds-mobile/components/skeleton/

Docs **[observed-docs]**: patterns `topList` (default), `topListWithIcon`, `amountTopList`, `amountTopListWithIcon`, `subtitleList`, `subtitleListWithIcon`, `listOnly`, `listWithIconOnly`, `cardOnly`; custom modules `title | subtitle | list | listWithIcon | card | spacer(n)`; `repeatLastItemCount` default 3 (`infinite` = 30); `background grey|white|greyOpacity100` (default grey).
**[observed-pkg]**: wrapper padding `0 24px`; colours: grey → grey100 (light) / grey50 (dark), white → background, greyOpacity100; module boxes: list 100% × 64px r18 mb16; title 50% × 30px r11 mb12; subtitle 33% × 22px r9 mb12; card 100% × 240px r38 mb20; listWithIcon = 40px circle + 14px gap + bar (h42, r13) mb32; pulse opacity 0.2→1 and scale 0.96→1, `cubic-bezier(.6,0,0,.6)`, 0.6s, alternate infinite, stagger 0.1s per item; fade mask `linear-gradient(110deg, background, transparent)`.

### 3.17 Border — https://tossmini-docs.toss.im/tds-mobile/components/border/

Docs **[observed-docs]**: `variant full|padding24|height16` (default full); `full`/`padding24` divide items, `height16` divides sections; `height` overrides height16.
**[observed-pkg]**: full → hairline (tHairlineBackground) 1px; padding24 → same with `margin-left: 24px; width: calc(100% - 24px)`; height16 → `greyBackground` (grey100) 16px tall.

### 3.18 Paragraph — https://tossmini-docs.toss.im/tds-mobile/components/paragraph/

Docs **[observed-docs]**: `typography*` (t1…st13), `display block|inline`, `ellipsisAfterLines`, `textAlign`, `fontWeight regular|medium|semibold|bold` (default regular), `color`; children `Paragraph.Text`, `Paragraph.Icon`, `Paragraph.Badge`, `Paragraph.Link` (`type underline|none`; "밑줄이 없는 링크는 기본 색상이 blue500이에요").
Docs inline CSS **[observed-docs-css]**: default text colour `var(--adaptiveGrey900)`, `word-break: keep-all; overflow-wrap: anywhere; hyphens: auto`.

### 3.19 Other components (scanned, not used for recipes)

Agreement v3/v4, Asset (asset / frame), Bar Chart, Keypad (alphabet / full-secure / number), Board Row, Bottom Info, Bubble, Grid List, Highlight, Icon Button, List Footer, Loader, Menu (dropdown radius 20px, shadow `0 16px 60px greyOpacity200` **[observed-pkg]**), Modal, Numeric Spinner, Post, Progress Bar, Progress Stepper, Rating, Result, Search Field, Segmented Control, Slider, Stepper, Table Row, Text Button, Tooltip (bubble radius 24px, padding 16px 20px, shadow `0 2px 30px greyOpacity200` **[observed-pkg]**), TextArea, SplitTextField, overlay hooks `useToast` / `useDialog` / `useBottomSheet`.

---

## 4. Elevation **[observed-pkg]**

No elevation page in the docs → docs page **[not found]**. Package scale `Gl`:

| level | offsetY | blur | light colour | dark colour |
|---|---|---|---|---|
| tiny | 1px | 3px | greyOpacity200 `rgba(0,27,55,0.1)` | greyOpacity900 |
| weak | 2px | 30px | greyOpacity200 | greyOpacity900 |
| medium | 16px | 60px | greyOpacity300 `rgba(0,29,58,0.18)` | greyOpacity900 |

Used by: Toast `0 2px 30px greyOpacity200` (weak); Tooltip box `greyOpacity200 0 2px 30px` (weak); Menu dropdown `0 16px 60px greyOpacity200`; slider thumb `0 0 0 1px greyOpacity200, 0 8px 8px 0 greyOpacity200, 0 2px 3px 0 greyOpacity300`; numeric spinner `0 1px 3px rgba(0,0,0,0.09)`. Cards and list rows have no shadow; separation is by hairline and grey section gaps.

## 5. Radius (collected; no radius page in docs → **[not found]** as a foundation)

8px (small button, f11–f13 badge), 9–14px (badge by size), 10px (medium button), 12px (ListRow touch layer), 14px (large button, TextField box), 15px (switch), 16px (xlarge button, BottomCTA button), 18px (skeleton list), 20px (multi-line toast, menu), 24px (dialog, tooltip), 28px (bottom sheet), 38px (skeleton card), 100px (single-line toast pill), 50% (circle assets). All **[observed-pkg]** / **[observed-docs-css]**.

## 6. Spacing (no spacing page in docs → **[not found]** as a foundation)

Recurring values: screen gutter 24px (Top, ListHeader, ListRow medium, Skeleton, TextField line/big, label/help); 20px (BottomCTA sides and bottom, ListRow small horizontal, TextField box inner); vertical rhythm 8 / 12 / 16 / 24px (ListRow verticalPadding); Top `upperGap`/`lowerGap` 24px; ListHeader `24px 0 8px`; Double CTA gap 8px; section gap 16px (Border height16). All **[observed]** in components; grouping them into a scale is **[inferred]**.

## 7. Iconography

- Icons are referenced by name (`icon-arrow-right-mono`, `icon-arrow-right-small-mono`, `icon-arrow-down-mono`, `heart-line`, `icon-gift-red`, `icon-point-circle-mono`, `icon-system-arrow-back-ios-outlined`); `-mono` icons accept a colour. **[observed-docs]** / **[observed-pkg]**
- Apps in Toss **[observed-ait]**: about 7,000+ icons and emoji are provided via App Builder / Figma; use icons at **24–40px**; don't combine two or more icons/emoji side by side; Toss graphics may be used only for in-service UI inside Apps in Toss, not for app logos/thumbnails; all Toss graphics are Viva Republica IP.
- The icon artwork itself is not public → icon SVG set **[not found]**; the skill must draw its own simple line icons. **[inferred]**

## 8. Motion **[observed-pkg]**

- Spring presets (`stiffness / damping / mass`): basic 200/30/1, small 480/50/1, quick 800/55/1, medium 270/25/1, large 100/15/1, slow 70/20/1, rapid 1000/55/1, bounce 300/15/1.
- Bezier presets: linear `[0,0,1,1]`, ease `[.6,0,0,.6]`, out `[.25,.1,.25,1]`, expo `[.16,1,.3,1]`, back `[.34,1.56,.64,1]`; default bezier duration 0.5s (`default = out`).
- Usage: press → scale 0.96 with `rapid`, release with `quick` (Button, Tab item, Switch); Checkbox press 0.9; dialog-like box enter opacity (`basic`) + scale 0.9→1 (`large`); badge pop scale 0→1.25→1 (`quick` then 300/15); ListRow shine 2.5s `[.37,0,.63,1]`; colour transitions 0.1s ease-in-out (Button), 0.3s ease (Tab), 0.2s ease (TextField overlay).
- Converting springs to CSS `cubic-bezier` + duration is **[inferred]** (CSS has no spring primitive).

## 9. Dark mode

- Dark palette **[observed-pkg]** (table 1.1 / 1.2). Docs Colors page has no dark section → docs dark-mode guidance **[not found]**.
- `TDSMobileAITProvider` passes `colorPreference: "light"` unconditionally **[observed-pkg]** → mini-apps built with the AIT provider render light.
- Apps in Toss graphics guidance **[observed-ait]**: graphics must read well in both light and dark mode; logos need a background that works in both.

## 10. UX writing — https://developers-apps-in-toss.toss.im/design/consumer-ux-guide.md **[observed-ait]**

(TDS Mobile docs have no UX-writing page → **[not found]** there; the rules below come from Apps in Toss.)

1. **해요체** for every string in the product, in every situation.
2. **능동적 말하기** — active voice. `됐어요 → 했어요`; drop '~었'; swap verbs. Passive allowed for: service end / expiry (but not for things that end on a recurring cycle), effects on the user (연체, 해지, 적용), reassurance (data-collection notices).
3. **긍정적 말하기** — "안 돼요, 없어요 (X) → ~하면 할 수 있어요 (O)"; `없어요 → 있어요`. Negative allowed when a service can't be used by policy (give the reason), when only some features are unavailable, and for reassurance.
4. **캐주얼한 경어** — avoid `~시겠어요?`, `~시나요?`, `~께`; drop '~시'; `계시다 → 있다`; `여쭈다 → 확인하다/묻다`; `께 → 에게`. If dropping honorifics makes a question awkward, make the wanted information the subject. Polite `~시나요?/~셨나요?` allowed when using the user's context, guessing their situation, or asking for goodwill (surveys).
5. **{명사}+{명사} 쓰지 않기** — unpack Sino-Korean noun stacks into verbs, or at least `{명사}가 {명사}해서`.
6. `되어요 (X) → 돼요 (O)`.
7. Dialog left button is always **닫기**, never **취소**.
8. Dark-pattern rule: CTA labels must say what happens next; don't repeat the screen's value proposition in the CTA; no exaggerated helper text over the CTA.
9. Brand names in Korean when possible ("토스" OK, "Toss" not recommended).

Other Apps in Toss UX rules **[observed-ait]**: no bottom sheet on entry (including notification-consent sheets); no blocking sheet on back; always give a way out; no surprise interstitial ads; tab bar (if any) must be Toss's floating tab bar, 2–5 tabs; avoid decorative effects, particles, heavy gradients; one key graphic per screen.

## 11. Licence / IP notes **[observed-ait]**

- https://developers-apps-in-toss.toss.im/design/components.md: all materials Toss provides via Apps in Toss (incl. TDS) belong to Toss; partners may use them only within Apps in Toss.
- https://developers-apps-in-toss.toss.im/design/prepare/figma-ui-license.md: the TDS Mobile UI Kit may be used only to build/design/prototype Apps in Toss apps; using it in other projects, commercial reuse, copying/modifying/redistributing kit components is prohibited; all brand assets, components and styles belong to Viva Republica Inc.
- Consequence for this skill **[inferred]**: ship no TDS code, kit files, icons, fonts or illustrations; describe the publicly documented design language in our own words and our own CSS; say clearly that output is "Toss-style", not an official Toss product.

## 12. Things looked for and not found

- Light font weight number (2.2).
- A public licence or download for Toss Product Sans (2.6).
- Foundation pages for spacing, radius, elevation, iconography, motion, dark mode (docs have only Colors and Typography under "파운데이션").
- A TDS "semantic colour" layer (`primary`, `success`, `text-sub` …): TDS exposes palette + background tokens only; the semantic layer in `tokens.css` is **[inferred]** and mapped from component usage.
- Toss Blue focus-ring spec: TDS components set `outline: none` on focus (Button) and rely on native/touch feedback → focus ring **[not found]**; the skill's 2px focus ring is **[inferred]**.
- An official dark-mode brand-colour rule for custom brand colours (only light is forced by the AIT provider).

## 13. Skill decisions derived from the evidence (all **[inferred]**, values chosen from observed TDS palette steps)

| Token | toss-blue | toss-black | Why it differs from the raw TDS usage |
|---|---|---|---|
| `--color-primary` | blue500 `#3182f6` | grey900 `#191f28` | Theme accent. toss-black = TDS brandPrimaryColor rule (§3.2), fill kept as-is because OKLCH L 0.237 < 0.40. |
| `--color-primary-weak` | blue300 @ 0.15 | grey700 @ 0.07 | Both observed (§3.1 table / §3.2 rule). |
| `--color-on-primary-weak` | blue700 | grey700 | TDS uses blue600 (3.97:1 on the weak tint); one step darker gives 4.78:1. toss-black value is the TDS rule. |
| `--color-primary-text` | blue700 | grey900 | TDS `Paragraph.Link` default blue500 is 3.71:1 on white. |
| `--color-field-focus-label` | blue700 | grey900 | TDS focused label blue600 is 4.49:1 (below 4.5). |
| `--color-badge-brand-text` | blue800 | grey700 | TDS blue weak badge text blue700 on its tint is 4.49:1; blue800 gives 5.47:1. toss-black uses the TDS elephant weak badge as-is. |
| `--color-on-danger-weak` | red700 | red700 | TDS red600 on the weak tint is 3.98:1; red700 gives 4.66:1. |
| `--color-danger-text` | red700 | red700 | TDS error help text red600 is 4.49:1. |
| `--color-success` / `--color-success-text` | green600 / green800 | same | TDS has no "success" token; green600 = green badge fill (3.31:1 non-text), green800 = 4.75:1 text. |
| `--color-selected`, `--color-focus`, `--color-tab-indicator`, `--color-tab-text-selected`, `--color-field-focus-line`, `--color-field-focus-overlay` | TDS values (blue500, blue500, grey800, grey800, blue400, blue900 @ 0.05) | grey900 / grey900 @ 0.05 | toss-black extension: TDS 2.5.1 hard-codes these and does not derive them from the brand colour (§3.2). Focus ring itself is a skill rule (TDS sets `outline: none`). |
| `data-contrast="aa"` block | primary → blue700, danger → red700, placeholder → grey600, selected → blue700 | danger → red700, placeholder → grey600 | Opt-in strict WCAG AA mode; default mode keeps TDS fills. |
| `--dur-spring-*` | 150 / 220 / 400 / 530 / 660 ms | same | 1%-settle time of the TDS springs rapid / quick / medium / basic / large, computed by numeric simulation of stiffness/damping/mass (§8). |
| `--mobile-max` | 480px | same | Desktop centring width. TDS code switches some tooltip layouts at `window.innerWidth > 480` and caps toasts at 375px **[observed-pkg]**; the 480px column is the skill's choice. |
| `--radius-card` | 20px | same | Grey container radius used in the TDS Border docs example (`borderRadius: 20`) **[observed-docs]**; reused for wide-layout panels. |

Contrast results for both themes (default and `aa` modes) are produced by `toss-design/scripts/contrast-check.py` and pasted into each `themes/<name>/design.md`.
