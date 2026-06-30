# Design Reference — claude

- **Name:** `claude`
- **Source:** https://www.anthropic.com/
- **Type:** AI research lab / product marketing site (Anthropic — maker of Claude)
- **Recognition:** Reference brand system for "thoughtful, human, calm" AI design
- **Studio:** Anthropic (in-house brand)
- **Captured:** 2026-06-30

## Vibe (one line)

Warm paper, not cold chrome — a calm, editorial,書-like canvas where generous
whitespace and a single clay/coral accent make AI feel **human and considered**,
intellectually rigorous without corporate coldness. Quiet confidence.

## Color Palette

| Role | Value | Notes |
|------|-------|-------|
| Canvas / background | warm ivory `#F0EEE6` | the signature Anthropic "paper" cream; soft, low-glare, never pure white |
| Surface / raised | off-white `#FAFAF7` → `#FFFFFF` | cards / panels lift very slightly off the cream |
| Primary text / UI | near-black slate `#191919` | warm charcoal, not `#000`; high contrast on cream |
| **Signature accent** | **clay / "book cloth" `#CC785C`** | the rationed warm accent — CTAs, links, marks. A brighter coral `#D97757` is the variant seen on claude.ai |
| Muted / secondary | warm grey `#6B6862` | captions, metadata, secondary nav |
| Hairline / border | `#E3E1D9` | quiet dividers on the cream |

Discipline: **warm-neutral field + one earthy accent.** The clay/coral is the
*only* chromatic color — used for intent (links, primary CTA, brand marks), never
as decoration. Warmth comes from the cream paper and the charcoal ink, not from
gradients. (Observed: brand palette is documented; exact per-element site hex was
not scraped from markup — clay `#CC785C` / coral `#D97757` / cream `#F0EEE6` are
the canonical Anthropic brand values, treat as authoritative, fine-tune if needed.)

> Accessibility note: clay `#CC785C` on cream `#F0EEE6` ≈ 2.6:1 — **below 4.5:1
> for body text.** Use the accent for large headings, marks, icons, and *fills*
> (pair a coral fill with `#191919` or white text and verify the pair), but keep
> small body copy in charcoal `#191919` on cream. Darken the accent toward
> `#B5654A` when it must carry small text on the light field.

## Typography

- **Headings:** an editorial **transitional/old-style serif** with personality —
  Anthropic ships "Copernicus" / "Tiempos"-class display serifs. Free stand-ins:
  **Fraunces**, **Tiempos**, **Lora**, or **Source Serif 4**. Used large, tight,
  and confident for display headlines — this serif is what makes the page read
  "thoughtful publication" instead of "SaaS landing".
- **Body / UI:** a clean, humanist **grotesque sans** — Anthropic's "Styrene".
  Free stand-in: **Inter** (or `-apple-system`). 400 body, 500–600 labels.
- **Pairing rule:** serif display + sans body. Sentence case for body, title case
  for nav. Minimal letter-spacing; generous line-height (1.5–1.7) for calm reading.
- **Scale:** large, airy headline → comfortable 17–18px body. Hierarchy by serif-
  vs-sans and size, not by color.

## Layout & Grid

- Generous whitespace is the primary layout tool — lots of breathing room, wide
  margins, unhurried vertical rhythm.
- Full-bleed centered hero with a short editorial headline; modular **card grid**
  for "Latest / releases / research" discovery below.
- Asymmetric spacing creates rhythm; soft, slightly rounded corners on cards and
  buttons (gentle radius, ~8–12px) — friendly, not sharp.
- Horizontal top nav with dropdown submenus; calm, minimal chrome.
- Mobile: single column, preserve the cream field and generous padding.

## Motion & Interaction

Restraint is the signature — motion is subtle and supportive, never flashy.

- **Hover:** quiet color shift toward the clay accent on links; gentle lift /
  background-tint on cards. Short, soft easing (ease-out, ~150–250ms).
- **Transitions:** smooth, understated fades and small translations on scroll-in;
  nothing that competes with the content.
- **No custom cursor, no cinematic wipes** — the calm comes from typography and
  space, not kinetic spectacle. Respect `prefers-reduced-motion`.

## Imagery & Texture

- Clean and minimal: relies on typography + whitespace rather than heavy imagery.
- Where used: warm, human-centered photography and Anthropic's soft geometric /
  abstract brand illustrations (rounded, paper-cut, warm-toned).
- Flat surfaces; very soft shadows at most. No neon, no glossy gradients, no
  decorative drop-shadow stacks.

## Tone / Mood

Approachable and intellectually rigorous. Warm authority. Reads like a
well-set essay or a research publication — confident, unhurried, human. "Safety
at the frontier," said calmly.

## Signature Techniques to Reproduce

1. Warm ivory paper canvas (`#F0EEE6`) + charcoal ink (`#191919`) — never pure
   white/black.
2. A single rationed earthy accent (clay `#CC785C` / coral `#D97757`) for intent
   only (links, primary CTA, marks).
3. Editorial **serif display headlines** paired with a clean **sans body** —
   publication, not dashboard.
4. Generous whitespace and unhurried vertical rhythm as the main "design".
5. Soft, gently-rounded surfaces with minimal, quiet motion; calm over kinetic.

## Do / Don't

- **Do** use the cream paper field and charcoal ink for a warm, low-glare canvas.
- **Do** ration the clay/coral for intent; keep body text charcoal.
- **Do** pair a serif display with a sans body for the editorial feel.
- **Do** lean on whitespace and rhythm; keep motion subtle and supportive.
- **Don't** use pure `#FFFFFF` / `#000000` — it kills the warmth.
- **Don't** put small body text in clay/coral on cream (contrast); darken or
  switch to charcoal.
- **Don't** add a second accent, neon, glossy gradients, or heavy shadows.
- **Don't** ship motion without a `prefers-reduced-motion` fallback.

## Implementation Notes

- Observed stack: marketing site is a modern JS framework (Next.js-class) with a
  system/Inter-class sans + a licensed display serif (Styrene + Copernicus/Tiempos
  in production; use Fraunces/Source Serif 4 + Inter as free stand-ins).
- Use warm neutrals as CSS tokens (`--canvas:#F0EEE6; --ink:#191919;
  --accent:#CC785C`); avoid hardcoding pure white/black.
- Verify every coral/clay text or CTA pair against WCAG 4.5:1 (it often fails on
  cream) — prefer accent for large type, fills, and marks; charcoal for body.
- Soft radii + very soft shadows only; reserve space for media to avoid CLS.
