# Design Reference — openai

- **Name:** `openai`
- **Source:** https://openai.com/
- **Type:** AI research lab / product site (OpenAI — maker of ChatGPT)
- **Recognition:** Reference brand system for "clinical, high-contrast, engineered" AI design
- **Studio:** OpenAI (in-house brand)
- **Captured:** 2026-06-30 (computed styles observed from the live site via headless Chrome)

## Vibe (one line)

Stark, clinical, engineered — a pure black-on-white canvas with no chromatic
color at all, where confident grotesque type, sharp square corners, and ruthless
whitespace do everything. Maximum contrast, zero decoration. Precision as a brand.

## Color Palette

| Role | Value | Notes |
|------|-------|-------|
| Canvas / background | pure white `#FFFFFF` | observed `rgb(255,255,255)` on body — true white, no warm tint |
| Primary text / UI | pure black `#000000` | observed `rgb(0,0,0)`, dominant across the page (≈680 elements) |
| Secondary text | black @ 60% `rgba(0,0,0,0.6)` ≈ `#666666` | observed; used for sub-copy / metadata |
| Tertiary / disabled | black @ 44% `rgba(0,0,0,0.44)` ≈ `#919191` | observed; quietest tier |
| Hairline / surface | black @ 4–12% `rgba(0,0,0,0.04→0.12)` | observed; dividers, faint card fills |
| **"Accent"** | **inverted black `#000000`** | there is *no chromatic accent* — emphasis is a solid black fill / full inversion (black button, white text) |
| Legacy accent (optional) | ChatGPT green `#10A37F` | NOT used on the current marketing site; only if a product (ChatGPT) context calls for it |

Discipline: **monochrome, literally.** No hue at all on the marketing surface.
Hierarchy comes from **opacity tiers** (100% / 60% / 44%) and from **inversion**
(black-on-white ↔ white-on-black), never from color. If you reach for a color,
you've left the system.

> Accessibility note: pure black `#000` on pure white `#FFF` ≈ **21:1** — the
> maximum; black fill + white text is equally safe. The only caveat is optical
> *halation* (pure #000 on #FFF can shimmer for some readers in long body copy) —
> the brand keeps true black, but you may soften body to `#111`/`#0A0A0A` for
> very long passages without breaking the look.

## Typography

- **Family:** **"OpenAI Sans"** (custom variable grotesque) — observed
  `font-family: "OpenAI Sans", "OpenAI Sans Variable Scripts", sans-serif`.
  It's a clean, slightly humanist neo-grotesque. Free stand-ins: **Söhne**,
  **Inter**, **Helvetica Now / Neue**, or `-apple-system`.
- **Treatment:** confident and plain. Large bold display headlines; sentence case
  for body, title case for nav. Tight-to-neutral letter-spacing; no decorative
  tracking. One family does headline + body — no serif anywhere.
- **Hierarchy by size + weight + opacity**, not by color. Few intermediate sizes;
  big jump from display to body.
- **Numerals:** plain lining figures; tabular where data is tabular.

## Layout & Grid

- Generous whitespace and a clean modular grid; lots of air, unhurried rhythm.
- Full-bleed sections; modular card grid for research / product / news discovery.
- **Sharp corners** — observed button `border-radius: 0px`. Square edges
  everywhere read as precise / engineered (the opposite of friendly rounding).
- Minimal top nav, lots of negative space, edge-to-edge media where used.
- Mobile: single column, preserve the stark white field and square edges.

## Motion & Interaction

Functional and restrained — motion serves clarity, never spectacle.

- **Hover:** quiet opacity / underline shifts; black ↔ inverted fill on buttons.
  Short ease-out (~150–250ms). No custom cursor, no cinematic transitions.
- **Transitions:** understated fades / small translations on scroll-in.
- Respect `prefers-reduced-motion` — the design barely depends on motion anyway.

## Imagery & Texture

- Mostly type + whitespace. Where imagery appears: clean photography or abstract
  generative / 3D forms, often desaturated or monochrome to fit the B&W field.
- Flat surfaces; effectively no shadows, no gradients, no decorative texture.
  The starkness *is* the texture.

## Tone / Mood

Clinical, precise, authoritative, engineered. Confident minimalism with nothing
to prove and nothing extra. Reads like a research lab's letterhead, not a
consumer brand. Cool where `claude` is warm.

## Signature Techniques to Reproduce

1. Pure white canvas + pure black ink — true `#FFF`/`#000`, no warm tint.
2. Zero chromatic accent: emphasis via solid black fills and full inversion.
3. Opacity-tiered hierarchy (100% / 60% / 44% black) instead of color.
4. Custom grotesque ("OpenAI Sans" → Inter/Söhne stand-in), one family, large
   and confident.
5. Sharp `0px` corners and ruthless whitespace — engineered, not friendly.

## Do / Don't

- **Do** use true white/black for maximum-contrast minimalism.
- **Do** build hierarchy from opacity and inversion, not color.
- **Do** keep corners square and surfaces flat.
- **Do** lean on whitespace; keep motion functional.
- **Don't** introduce a chromatic accent (not even the legacy ChatGPT green) on a
  general OpenAI surface — reserve `#10A37F` strictly for ChatGPT-product context.
- **Don't** round corners or add shadows/gradients — it breaks the engineered feel.
- **Don't** add a serif; it's a single-grotesque system.
- **Don't** ship motion without a `prefers-reduced-motion` fallback.

## Implementation Notes

- Observed stack: modern JS framework; custom variable font "OpenAI Sans".
- CSS tokens: `--canvas:#FFFFFF; --ink:#000000; --ink-60:rgba(0,0,0,.6);
  --ink-44:rgba(0,0,0,.44); --hairline:rgba(0,0,0,.12);` accent = inverted black.
- `border-radius: 0`; avoid shadows/gradients. Use Inter (or Söhne) as the free
  OpenAI-Sans stand-in. Reserve space for media to avoid CLS.
