# Apple's numbers for a desktop and a phone

In short: on a phone, controls grow to 44 pt and text gets bigger, not smaller (iOS body 17 pt against macOS 13 pt). Only display headlines shrink, by 1.4 to 1.75 times on apple.com. Every number below has a source; where no source states one, the table says so.

Read section 1 for an app or dashboard, section 2 for a marketing or reading page, section 3 for the web rules both depend on. Section 4 lists what no source states — do not present a guess there as Apple's.

All sources were read on 2026-11-16. HIG pages are under `https://developer.apple.com/design/human-interface-guidelines/` (the site is a script-rendered app; its text is at `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`). apple.com stylesheet paths are versioned and will move.

## 1. Apps and dashboards — the Human Interface Guidelines

Desktop means macOS; phone means iOS (iPadOS takes the iOS column).

| What | Desktop (macOS) | Phone (iOS) | Phone ÷ desktop | Source |
|---|---|---|---|---|
| Default control size | 28×28 pt | 44×44 pt | 1.57 | accessibility: "iOS, iPadOS \| 44x44 pt \| 28x28 pt"; "macOS \| 28x28 pt \| 20x20 pt" |
| Smallest control | 20×20 pt | 28×28 pt | 1.40 | same table |
| Button hit region | 44×44 pt (see note) | 44×44 pt | 1.0 | buttons: "a button needs a hit region of at least 44x44 pt" |
| Space around a control | about 12 pt with a bezel, about 24 pt without | same | 1.0 | accessibility: "add about 12 points of padding around elements that include a bezel … about 24 points of padding … around the element's visible edges" |
| Default text size | 13 pt | 17 pt | 1.31 | typography / accessibility: "iOS, iPadOS \| 17 pt \| 11 pt"; "macOS \| 13 pt \| 10 pt" |
| Smallest text size | 10 pt | 11 pt | 1.10 | same table |
| Text enlargement to support | — | at least 200% | — | accessibility |
| Contrast, text up to 17 pt | 4.5:1 | 4.5:1 | — | accessibility: "Up to 17 pts \| All \| 4.5:1" |
| Contrast, 18 pt or bold | 3:1 | 3:1 | — | accessibility: "18 pts \| All \| 3:1", "All \| Bold \| 3:1" |
| Contrast in Dark Mode | 4.5:1 minimum, aim for 7:1 in small text | same | — | dark-mode: "strive for a contrast ratio of 7:1, especially in small text" |
| Corners inside a bar | concentric with the bar's corners | same | — | toolbars: "standard buttons, text fields, headers, and footers have corner radii that are concentric with bar corners" |
| Split-view divider | 1 pt | — | — | split-views: "thin divider measures one point" |

Note — the desktop hit target: the accessibility page gives macOS a 28×28 pt default; the buttons page says 44×44 pt for any button. Treat 28 as the desktop floor for a pointer and 44 as what a touch screen needs.

### Text styles (typography → Specifications), size / leading in pt

Map every text role in the UI to one style, then take the column for the platform. A phone uses the iOS column even when the layout is the same.

| Style | Desktop (macOS) | Phone (iOS, default size) | Desktop ÷ phone |
|---|---|---|---|
| Large Title | 26/32 | 34/41 | 0.76 |
| Title 1 | 22/26 | 28/34 | 0.79 |
| Title 2 | 17/22 | 22/28 | 0.77 |
| Title 3 | 15/20 | 20/25 | 0.75 |
| Headline | 13/16 bold | 17/22 semibold | 0.76 |
| Body | 13/16 | 17/22 | 0.76 |
| Callout | 12/15 | 16/21 | 0.75 |
| Subheadline | 11/14 | 15/20 | 0.73 |
| Footnote | 10/13 | 13/18 | 0.77 |
| Caption 1 | 10/13 | 12/16 | 0.83 |
| Caption 2 | 10/13 medium | 11/13 | 0.91 |

Every style is regular weight unless marked. Leading ÷ size runs from 1.18 to 1.38 on iOS and from 1.18 to 1.33 on macOS (computed) — tighter than the 1.4–1.5 many web pages use.

SF Pro tracking (typography → Tracking values), size → tracking in 1/1000 em: 11 → +6, 12 → 0, 13 → −6, 15 → −16, 17 → −26, 20 → −23, 22 → −12, 24 → +3, 28 → +14, 34 → +12, 48 → +8, 64 → +4, 80–96 → 0. These values are for SF Pro. Do not copy them onto another typeface; Inter and the Korean faces have their own spacing.

## 2. Marketing and reading pages — apple.com's own stylesheet

apple.com shows how Apple scales a page from a wide window to a phone. Desktop is 1069 px and wider; phone is 734 px and narrower; the middle tier is in brackets.

| What | Desktop | Phone | Desktop ÷ phone | Source |
|---|---|---|---|---|
| Breakpoints | base, and `min-width: 1441px` | `max-width: 1068px`, `max-width: 734px` | — | homepage `main.built.css` grid classes |
| Content width | 980 px | 87.5% of the window (692 px in the middle tier) | — | `.section-content {width: 980px}` → `692px` → `87.5%` |
| Phone side margin | — | about 24 px each side at 390 px (computed from 87.5%) | — | computed |
| Grid | 12 columns, 24 px gutter | 24 px gutter | 1.0 | `.grid` |
| Global nav height | 44 px | 48 px | 0.92 | `globalheader.css` `--r-globalnav-height` |
| Body text | 17 px, line-height 1.4706 (25 px), letter-spacing −0.022em | same, no override | 1.0 | `body` |
| Small text | 14/20 and 12/16 | same | 1.0 | `.typography-body-reduced`, `.typography-caption` |
| Button heights | 24 (12 px text), 36 (14 px), 44 (17 px), 56 (17 px) | — | — | `.button` padding plus line-height (computed) |
| Hero call-to-action | 44 px | 36 px | 1.22 | `.section-hero .button` |
| Button radius | pill (980 px) | same | — | `--sk-button-border-radius: 980px` |
| Card radius | 18 px, some pages 28 px | same | — | `.tile-rounded`, `--sk-tile-border-radius` |
| Focus ring | 2 px, offset 3 px | same | — | `.button:focus-visible` |

Headlines (size / line-height in px):

| Class | Desktop | Phone [middle] | Desktop ÷ phone |
|---|---|---|---|
| headline-super | 80/84 | 48/52 [64] | 1.67 |
| headline-elevated | 64/68 | 40/44 [48] | 1.60 |
| headline | 48/52 | 32/36 [40] | 1.50 |
| headline-reduced | 40/44 | 28/32 [32] | 1.43 |
| tile-headline (homepage) | 56/60 | 32/36 [48] | 1.75 |
| intro | 21/29 | 19/27 | 1.11 |

Headlines and eyebrows are weight 600; body and intro are 400. Section padding is set per page (144 → 112 px on one page, 160 → 96 px on another): there is no one apple.com value.

## 3. Web rules both kinds of page depend on

| What | Value | Source |
|---|---|---|
| Smallest target (WCAG 2.2 SC 2.5.8, AA) | 24×24 CSS px, or a 24 px circle on the target's centre that touches no other target | w3.org/TR/WCAG22/#target-size-minimum |
| Enhanced target (SC 2.5.5, AAA) | 44×44 CSS px | #target-size-enhanced |
| Text contrast (SC 1.4.3) | 4.5:1; large text 3:1 (about 24 px, or 18.5 px bold) | #contrast-minimum |
| Control and graphic contrast (SC 1.4.11) | 3:1 against what is next to it | #non-text-contrast |
| iOS Safari zoom on focus | zooms into a field whose text is under 16 px | WebKit `WKWebViewIOS.mm`: `webViewStandardFontSize = 16` |
| Notch and home bar | `env(safe-area-inset-*)` with `viewport-fit=cover` | webkit.org/blog/7929 |

## 4. Not stated by any source

- iOS or macOS layout margins and a readable width in points. The HIG only says its layout guides "restrict the width of text for optimal readability".
- Navigation bar, toolbar, tab bar and sidebar heights on iOS or macOS.
- The radius formula. The HIG says "concentric" and gives no formula. inner radius = outer radius − inset is the geometry that makes two corners concentric; it is not a quoted Apple rule.
- How HIG points map to CSS pixels. On Apple devices a CSS px at 100% zoom is drawn the size of a point, but no source fetched states it — call it an assumption when you rely on it.
- Motion durations. The HIG motion page has no numbers. For curves and durations use the `motion-design` and `apple-design` skills.
- A single apple.com section padding or hero headline size — both differ by page.
- apple.com letter-spacing does not follow the HIG tracking table (17 px: −0.022em against −0.026em). Use one or the other, not both.
