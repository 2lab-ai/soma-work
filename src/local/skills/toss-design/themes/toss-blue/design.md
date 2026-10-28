# Design Reference — toss-blue

- **Name:** `toss-blue`
- **Source:** https://tossmini-docs.toss.im/tds-mobile/
- **Type:** Mobile product design system (fintech super-app / Apps in Toss mini-apps) — theme of the `toss-design` skill
- **Recognition:** The default TDS look: the Toss Blue CTA (`#3182F6`) on a white, hairline-divided mobile canvas. Same palette that Apps in Toss mini-apps get when no brand colour is set.
- **Studio:** Toss (Viva Republica, Inc.) — TDS, in-house design system. This file is an original distillation; no Toss assets are included.
- **Captured:** 2026-10-26

## Vibe (one line)

Plain-spoken Korean fintech: a white canvas, big bold left-aligned sentences, quiet grey lists and exactly one Toss Blue button that tells you what happens next.

## Color Palette

| Role | Value | Notes |
|------|-------|-------|
| Canvas / background | white `#FFFFFF` (`--color-bg`) | TDS `background`. Observed. |
| Grey canvas / section band | `#F2F4F6` (`--color-bg-grey`, grey100) | 16px bands between sections; desktop page field. Observed (`greyBackground`). |
| Surface / floating | `#FFFFFF` (`--color-surface`, `--color-surface-float`) | sheets, dialogs, wide-layout panels. Observed. |
| **Primary / CTA** | **Toss Blue `#3182F6`** (`--color-primary`, TDS blue500) | the one chromatic accent: primary fill buttons, BottomCTA, switch on, checkbox, focus ring. Observed. |
| On primary | `#FFFFFF` (`--color-on-primary`) | button label on blue. Observed. |
| Primary weak | `rgba(100,168,255,0.15)` + label `#1B64DA` | secondary "weak" button: blue300 at 15% (observed); label blue700 (TDS uses blue600 `#2272EB`; darkened for contrast). |
| Accent as text | `#1B64DA` (`--color-primary-text`, blue700) | links and accent words at body size. TDS's default link colour is blue500, which is 3.71:1 on white. |
| Field focus | label `#1B64DA`, line `#4593FC`, 5% `#194AA6` tint | TextField focus state (blue400 line and blue900 tint observed; label darkened from blue600). |
| Active tab | `#333D4B` (grey800) | TDS draws the tab indicator in near-black, not blue. Observed. |
| Brand badge | `rgba(49,130,246,0.16)` + `#1957C2` | TDS blue weak badge (text darkened from blue700 by one step for contrast). |
| Headline ink | `#191F28` (`--color-text-strong`, grey900) | key numbers, hero lines. Observed (Paragraph default). |
| Title ink | `#333D4B` (`--color-text`, grey800) | Top title, row titles, list headers. Observed. |
| Secondary text | `#4E5968` (`--color-text-secondary`, grey700) | subtitles, right-side text, captions on grey. Observed. |
| Description text | `#6B7684` (`--color-text-sub`, grey600) | descriptions on white only. Observed. |
| Placeholder / disabled | `#8B95A1` grey500 / `#B0B8C1` grey400 | placeholder hint / disabled; grey400 also for decorative chevrons. Observed. |
| Hairline / border | `rgba(0,0,33,0.07)` at 0.5px / `#E5E8EB` | list dividers / the rare solid border. Observed. |
| Scrim | `rgba(0,0,0,0.2)` | behind dialogs and sheets. Observed. |
| Danger | `#F04452` red500 fill, `#D22030` red700 text | errors, destructive actions. Observed values; text step chosen for contrast. |
| Success | `#02A262` green600 mark, `#028450` green800 text | confirmations. Observed values; semantic mapping inferred. |
| Warning | `#FFC342` yellow500 with `#333D4B` text | warning badge. Observed (yellow badge). |

Discipline: **White field, grey ink, one blue.** Toss Blue appears on at most one filled button per screen (usually the BottomCTA) plus small state marks (switch, checkbox, focus, a brand badge). Hierarchy is carried by greys and weight, never by extra hues. Red, green and yellow are status colours only.

Full TDS scales (grey, blue, red, orange, yellow, green, teal, purple, greyOpacity; 50–900) are in `tokens.css` as `--tds-*`.

> Accessibility note: Measured with `scripts/contrast-check.py themes/toss-blue/tokens.css` (WCAG 2.x, alpha composited over white). Default (TDS) mode:
>
> | Pair | Ratio | Needs | Result | Use |
> |---|---|---|---|---|
> | text-strong on bg | 16.56:1 | 4.5:1 | PASS | body text |
> | text on bg | 11.00:1 | 4.5:1 | PASS | body text |
> | text-secondary on bg | 7.11:1 | 4.5:1 | PASS | body text |
> | text-sub on bg | 4.62:1 | 4.5:1 | PASS | body text |
> | text on bg-grey | 9.97:1 | 4.5:1 | PASS | body text |
> | text-sub on bg-grey | 4.19:1 | - | info | forbidden pairing: use text-sub-on-grey |
> | text-sub-on-grey on bg-grey | 6.45:1 | 4.5:1 | PASS | body text |
> | on-primary on primary | 3.71:1 | 4.5:1 | FAIL | button label |
> | primary on bg | 3.71:1 | 3.0:1 | PASS | non-text / large |
> | primary-text on bg | 5.41:1 | 4.5:1 | PASS | body text / link |
> | on-primary-weak on primary-weak | 4.78:1 | 4.5:1 | PASS | button label |
> | focus on bg | 3.71:1 | 3.0:1 | PASS | non-text |
> | selected on bg | 3.71:1 | 3.0:1 | PASS | non-text |
> | tab-indicator on bg | 11.00:1 | 3.0:1 | PASS | non-text |
> | tab-text on bg | 4.62:1 | 4.5:1 | PASS | label |
> | tab-text-selected on bg | 11.00:1 | 4.5:1 | PASS | label |
> | field-focus-label on bg | 5.41:1 | 4.5:1 | PASS | label |
> | badge-brand-text on badge-brand-bg | 5.47:1 | 4.5:1 | PASS | badge label |
> | on-neutral on neutral | 7.11:1 | 4.5:1 | PASS | button label |
> | on-neutral-weak on neutral-weak | 6.45:1 | 4.5:1 | PASS | button label |
> | on-danger on danger | 3.71:1 | 4.5:1 | FAIL | button label |
> | on-danger-weak on danger-weak | 4.66:1 | 4.5:1 | PASS | button label |
> | danger-text on bg | 5.26:1 | 4.5:1 | PASS | body text |
> | success-text on bg | 4.75:1 | 4.5:1 | PASS | body text |
> | success on bg | 3.31:1 | 3.0:1 | PASS | non-text |
> | on-warning on warning | 6.88:1 | 4.5:1 | PASS | badge label |
> | toast-text on toast-bg | 11.04:1 | 4.5:1 | PASS | body text |
> | text-placeholder on bg | 3.04:1 | 4.5:1 | FAIL | placeholder |
> | text on field (TextField fill) | 10.56:1 | 4.5:1 | PASS | input text |
> | text-placeholder on field (fill / focus / error) | 2.92 / ≤2.70 / 2.68:1 | 4.5:1 | FAIL | placeholder |
> | icon-strong on bg | 4.62:1 | 3.0:1 | PASS | non-text |
> | icon on bg | 2.01:1 | - | info | decorative |
> | text-disabled on bg | 2.01:1 | - | info | disabled (exempt) |
>
> - **White on Toss Blue is 3.71:1** (and white on red500 3.71:1). That is TDS's own pairing: it passes 3:1 but not 4.5:1, and 17px semibold is not WCAG "large text". **Restriction:** use it only as a button label at 17px semibold or larger (xlarge / large buttons, BottomCTA); never for body copy, captions, badges, or 13–15px button labels. Medium and small buttons use `dark weak` or `primary weak`.
> - Toss Blue as a non-text mark (focus ring, switch, checkbox) is 3.71:1: passes WCAG 1.4.11 (3:1).
> - **Placeholder grey500 is 3.04:1** on white and about 2.7–2.9:1 on the TextField fill: hint only, always paired with a visible label.
> - grey600 on the grey100 band is 4.19:1, so captions there use grey700 (6.45:1).
> - **Strict AA:** `<html data-contrast="aa">` swaps fills to blue700 `#1B64DA` (5.41:1) and red700 (5.26:1) and the placeholder to grey700 (grey600 is 4.44:1 on the TextField fill). Result: 0 failing pairs.

## Typography

- **Family:** `"Toss Product Sans"` first (Toss's proprietary face — used only if the viewer already has it installed; never shipped or linked), then **Pretendard** (SIL OFL, jsDelivr) as the real web font, then system UI fonts (`-apple-system`, `Apple SD Gothic Neo`, `Noto Sans KR`).
- **Scale (TDS tokens, size/line-height px):** t1 30/40 · t2 26/35 · t3 22/31 · t4 20/29 · t5 17/25.5 · t6 15/22.5 · t7 13/19.5; in-between "sub" sizes st1 29/38 … st13 11/16.5. Observed.
- **Roles:** page title t3 (or st2 28/37) bold grey800 · section title t5 bold · row title t5 bold, row description t6 regular grey600 (line-height 1.35) · body t5 · captions and labels t7 · buttons t5/t6/t7 semibold 600.
- **Weights:** 400 / 500 / 600 / 700 only. Bold for titles and amounts, semibold for buttons, medium for subtitles.
- **Rules:** `word-break: keep-all` for Korean; tabular numbers for amounts; sentence case; no letter-spacing tricks; let text grow with the OS larger-text setting (TDS supports up to about 310%).

## Layout & Grid

- One mobile column, 375–430px design width; `max-width: 480px` centred on desktop.
- 24px side gutter for titles and lists; 20px for the BottomCTA and field boxes.
- Vertical stack: (TopNavigation 44px) → Top title block (24px top and bottom) → 16px grey band → ListHeader (`24px 0 8px`) → ListRows (12px vertical padding, 44px minimum) → fixed BottomCTA (36px fade + 56px button + 20px bottom padding).
- No multi-column grids inside a screen. Wide reports use white panels (radius 20px, no shadow) on a grey100 field, two columns at 960px or more, each panel laid out like a mobile screen.
- Radii: buttons 8/10/14/16 by size, fields 14, list press layer 12, cards and menus 20, dialogs 24, sheets 28, toasts as pills.

## Motion & Interaction

- **Press:** tappables scale to 0.96 (spring stiffness 1000 / damping 55 ≈ 150ms in CSS), release with stiffness 800 / damping 55 (≈ 220ms). Buttons also dim 26% black; list rows show a grey 12px-radius layer.
- **Easing:** `cubic-bezier(.25,.1,.25,1)` default (0.5s), `(.16,1,.3,1)` expo, `(.34,1.56,.64,1)` back for small pops. Colour changes 100ms (buttons), 200ms (fields), 300ms (tabs).
- **Overlays:** dialogs fade in and scale from 0.9; bottom sheets slide up and close on a 50px drag down; toasts slide in as pills and leave after 3 seconds (5 seconds with a button).
- **Loading:** skeleton blocks pulse (opacity 0.2→1, scale 0.96→1, 0.6s, staggered 0.1s); buttons keep their width and show three pulsing dots.
- Respect `prefers-reduced-motion`. No parallax, no particles, no decorative loops.

## Imagery & Texture

- Flat white surfaces, no textures, no gradients except the BottomCTA's white fade.
- Icons: simple 24px line icons in a 40px `greyOpacity100` tile; 24–40px on screen; one icon at a time. Toss's own 7,000-icon set and 3D illustrations are Apps in Toss assets — don't copy them; draw your own.
- No emoji as icons. No stock photos as decoration. One key graphic per screen at most.
- Shadows only on floating layers: `0 2px 30px rgba(0,27,55,0.1)` (toast, tooltip), `0 16px 60px rgba(0,29,58,0.18)` (menus).

## Tone / Mood

Friendly, direct, trustworthy. Every string is 해요체, active and positive ("정리했어요", "~하면 할 수 있어요"), with casual honorifics (no "~시겠어요?"). Titles state the result in one sentence; CTAs say exactly what happens next; dialogs offer "닫기", never "취소". It feels like a capable friend explaining money, not a bank form.

## Signature Techniques to Reproduce

1. **One Toss Blue BottomCTA**: a full-width 56px, 16px-radius blue button pinned to the bottom with a 36px white fade above it and 20px side and bottom padding. Its label says the next action in 해요체 ("자동이체 등록하기").
2. **A big bold left-aligned sentence as the page title** (22/31 or 28/37, bold, grey800) with a 17px grey700 subtitle 4px below. No hero image, no centred headline.
3. **Hairline lists instead of cards**: 44px+ ListRows with a 40px grey icon tile, a bold 17px title over a 15px grey600 description, a bold right-aligned amount and a grey400 chevron, separated by 0.5px lines that start 24px in.
4. **Grey bands as section breaks**: a 16px grey100 band between sections and 24px gutters everywhere.
5. **Soft, physical touch feedback**: everything tappable shrinks to 96% and dims slightly; list rows get a grey 12px-radius press layer.

## Do / Don't

- **Do** keep the canvas white and separate content with whitespace, 0.5px hairlines and 16px grey bands.
- **Do** lead each screen with a big bold left-aligned sentence title.
- **Do** use exactly one primary fill per screen; secondary actions are weak or grey.
- **Do** right-align amounts in bold with tabular numbers.
- **Do** write all copy in 해요체, active and positive.
- **Don't** wrap list rows in cards, borders or shadows.
- **Don't** add decorative gradients, particles, emoji icons, or Toss logos and illustrations.
- **Don't** use Toss Blue for body text (3.71:1); use blue700 `#1B64DA` or grey.
- **Don't** put white text on blue below 17px semibold.
- **Don't** put grey600 text on the grey100 band; use grey700.
- **Don't** ship motion without a `prefers-reduced-motion` fallback.

## Implementation Notes

- Tokens: inline `themes/toss-blue/tokens.css` (`:root` custom properties). Component CSS reads only `--color-*`, `--t*-size/--t*-lh`, `--radius-*`, `--space-*`, `--shadow-*`, `--dur-*`/`--ease-*`. The other theme has identical names, so swapping the file re-themes the page.
- Recipes: `references/components.md` in the `toss-design` skill (Top, ListHeader, ListRow, Button, BottomCTA, Badge, Tab, TextField, Switch, Toast, Dialog, BottomSheet, Skeleton).
- Real mini-app equivalent: `@toss/tds-mobile` + `<TDSMobileAITProvider brandPrimaryColor="#3182F6">`, or `brand.primaryColor` in `apps-in-toss.config.ts` (SDK 3.x) / `granite.config.ts` (SDK 2.x). TDS derives only Button colours from the brand colour.
- Strict-AA mode: add `data-contrast="aa"` to `<html>`; table above shows the default mode.
- Font: Pretendard from `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css`; never bundle Toss Product Sans.
- Evidence and observed / inferred markers for every value: `references/tds-source-notes.md` in the skill.
