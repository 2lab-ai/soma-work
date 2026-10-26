# Design Reference — toss-black

- **Name:** `toss-black`
- **Source:** https://tossmini-docs.toss.im/tds-mobile/
- **Type:** Mobile product design system (fintech super-app / Apps in Toss mini-apps) — theme of the `toss-design` skill
- **Recognition:** TDS with the brand accent switched to Toss near-black (`#191F28`, TDS grey900), as an Apps in Toss mini-app gets with `brandPrimaryColor="#191F28"`. Monochrome, premium, still unmistakably Toss in layout and voice.
- **Studio:** Toss (Viva Republica, Inc.) — TDS, in-house design system. This file is an original distillation; no Toss assets are included.
- **Captured:** 2026-10-26

> **Local derivative, not an official TDS theme, and not dark mode.** toss-black is this skill's derivation of TDS with the brand accent set to grey900 `#191F28` on the same light canvas. TDS's own brand-colour hook (`brandPrimaryColor`) recolours only buttons; the extension to switches, checkboxes, focus, tabs and links is this skill's choice.

## Vibe (one line)

The Toss layout in ink: white canvas, big bold sentences, grey hairline lists and a single near-black button. Calm, premium and colour-free until a status needs colour.

## Color Palette

| Role | Value | Notes |
|------|-------|-------|
| Canvas / background | white `#FFFFFF` (`--color-bg`) | TDS `background`. Observed. |
| Grey canvas / section band | `#F2F4F6` (`--color-bg-grey`, grey100) | 16px bands between sections; desktop page field. Observed (`greyBackground`). |
| Surface / floating | `#FFFFFF` (`--color-surface`, `--color-surface-float`) | sheets, dialogs, wide-layout panels. Observed. |
| **Primary / CTA** | **Toss near-black `#191F28`** (`--color-primary`, TDS grey900) | the only accent: primary fill buttons, BottomCTA, switch on, checkbox, focus ring, active tab. Observed value; TDS keeps brand colours this dark as-is. |
| On primary | `#FFFFFF` (`--color-on-primary`) | label on near-black. 16.56:1. |
| Primary weak | `rgba(78,89,104,0.07)` + label `#4E5968` | secondary "weak" button. This is TDS's own rule for brand colours with OKLCH lightness < 0.40 (observed in `@toss/tds-mobile` 2.5.1). |
| Accent as text | `#191F28` (`--color-primary-text`) | links: same colour as titles, so **always underline links**. |
| Field focus | label `#191F28`, line `#191F28`, 5% near-black tint | TextField focus state (skill extension; TDS hard-codes blue here). |
| Active tab | `#191F28` | TDS uses grey800 `#333D4B`; toss-black moves it to the brand ink. |
| Brand badge | `rgba(78,89,104,0.16)` + `#4E5968` | TDS "elephant" weak badge. |
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

Discipline: **White field, grey scale, near-black accent, colour only for status.** The near-black fill appears on at most one filled button per screen; other actions are grey weak buttons. With no chromatic brand hue, hierarchy depends on size, weight and the grey ramp (900 → 800 → 700 → 600), so keep those steps distinct. Red, green, yellow and blue appear only as status colours or data, never as decoration.

Full TDS scales (grey, blue, red, orange, yellow, green, teal, purple, greyOpacity; 50–900) are in `tokens.css` as `--tds-*`.

> Accessibility note: Measured with `scripts/contrast-check.py themes/toss-black/tokens.css` (WCAG 2.x, alpha composited over white). Default (TDS) mode:
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
> | on-primary on primary | 16.56:1 | 4.5:1 | PASS | button label |
> | primary on bg | 16.56:1 | 3.0:1 | PASS | non-text / large |
> | primary-text on bg | 16.56:1 | 4.5:1 | PASS | body text / link |
> | on-primary-weak on primary-weak | 6.43:1 | 4.5:1 | PASS | button label |
> | focus on bg | 16.56:1 | 3.0:1 | PASS | non-text |
> | selected on bg | 16.56:1 | 3.0:1 | PASS | non-text |
> | tab-indicator on bg | 16.56:1 | 3.0:1 | PASS | non-text |
> | tab-text on bg | 4.62:1 | 4.5:1 | PASS | label |
> | tab-text-selected on bg | 16.56:1 | 4.5:1 | PASS | label |
> | field-focus-label on bg | 16.56:1 | 4.5:1 | PASS | label |
> | badge-brand-text on badge-brand-bg | 5.61:1 | 4.5:1 | PASS | badge label |
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
> | icon-strong on bg | 4.62:1 | 3.0:1 | PASS | non-text |
> | icon on bg | 2.01:1 | - | info | decorative |
> | text-disabled on bg | 2.01:1 | - | info | disabled (exempt) |
>
> - Near-black brand pairs all pass with a wide margin (white on `#191F28` = 16.56:1; weak label 6.43:1).
> - **White on red500 (danger fill) is 3.71:1.** **Restriction:** danger fills carry labels only at 17px semibold or larger (large / xlarge buttons); otherwise use the danger weak button (label red700, 4.66:1).
> - **Placeholder grey500 is 3.04:1**: hint only, always paired with a visible label.
> - grey600 on the grey100 band is 4.19:1, so captions there use grey700 (6.45:1).
> - Links and primary text share the title colour, so colour alone does not mark a link (WCAG 1.4.1): underline links.
> - **Strict AA:** `<html data-contrast="aa">` moves the danger fill to red700 (5.26:1) and the placeholder to grey600. Result: 0 failing pairs.

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

1. **One near-black BottomCTA**: a full-width 56px, 16px-radius `#191F28` button pinned to the bottom with a 36px white fade above; secondary action as a grey weak button beside it (8px gap).
2. **A big bold left-aligned sentence as the page title** (22/31 or 28/37, bold, grey800) with a 17px grey700 subtitle. No hero image, no centred headline.
3. **Hairline lists instead of cards**: 44px+ ListRows with a 40px grey icon tile, bold 17px title over a 15px grey600 description, bold right-aligned amount, grey400 chevron, 0.5px dividers inset 24px.
4. **Monochrome state marks**: switches, checkboxes, the active tab, focus rings and field focus all use the same `#191F28` ink, so the screen stays colour-free until a status (red, green) appears.
5. **Grey bands and soft touch feedback**: 16px grey100 bands between sections; tappables shrink to 96% with a slight dim.

## Do / Don't

- **Do** keep the canvas white and separate content with whitespace, 0.5px hairlines and 16px grey bands.
- **Do** lead each screen with a big bold left-aligned sentence title.
- **Do** use exactly one primary fill per screen; secondary actions are weak or grey.
- **Do** right-align amounts in bold with tabular numbers.
- **Do** write all copy in 해요체, active and positive.
- **Don't** wrap list rows in cards, borders or shadows.
- **Don't** add decorative gradients, particles, emoji icons, or Toss logos and illustrations.
- **Don't** reintroduce Toss Blue as a second accent (keep blue for data or status only).
- **Don't** leave links without an underline: they are the same colour as text.
- **Don't** put grey600 text on the grey100 band; use grey700.
- **Don't** ship motion without a `prefers-reduced-motion` fallback.

## Implementation Notes

- Tokens: inline `themes/toss-black/tokens.css` (`:root` custom properties). Component CSS reads only `--color-*`, `--t*-size/--t*-lh`, `--radius-*`, `--space-*`, `--shadow-*`, `--dur-*`/`--ease-*`. The other theme has identical names, so swapping the file re-themes the page.
- Recipes: `references/components.md` in the `toss-design` skill (Top, ListHeader, ListRow, Button, BottomCTA, Badge, Tab, TextField, Switch, Toast, Dialog, BottomSheet, Skeleton).
- Real mini-app equivalent: `@toss/tds-mobile` + `<TDSMobileAITProvider brandPrimaryColor="#191F28">`, or `brand.primaryColor` in `apps-in-toss.config.ts` (SDK 3.x) / `granite.config.ts` (SDK 2.x). TDS derives only Button colours from the brand colour.
- Strict-AA mode: add `data-contrast="aa"` to `<html>`; table above shows the default mode.
- Font: Pretendard from `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css`; never bundle Toss Product Sans.
- Evidence and observed / inferred markers for every value: `references/tds-source-notes.md` in the skill.
