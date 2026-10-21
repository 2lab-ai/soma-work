# Design Reference — il-capo-production

- **Name:** `il-capo-production`
- **Source:** https://www.awwwards.com/sites/il-capo-production
- **Type:** Video-production studio portfolio (Film & TV, Animation, Photo & Video)
- **Recognition:** Awwwards Site of the Day — score 7.35/10 (Design), Animations/Transitions 7.80/10
- **Studio:** AUGE EXPERIENCE
- **Captured:** 2026-06-30 (default reference shipped with the `ui-ux` skill)

## Vibe (one line)

Industrial cinema, "shaped for today" — a near-monochrome, content-first canvas
where the **video is the hero** and a single blood-red accent does all the
talking. Quiet UI, loud motion.

## Color Palette

| Role | Value | Notes |
|------|-------|-------|
| Canvas / background | near-black `#0A0A0A` → `#000000` | cinematic dark base; let footage glow against it |
| Primary text / UI | off-white `#F5F5F5` | high contrast on the dark canvas |
| **Signature accent** | **`#D60001` (vibrant red)** | the *only* chromatic color — CTAs, active states, hover, cursor, key labels |
| Muted / secondary | grey `#8A8A8A` | captions, metadata, inactive nav |

Discipline: **monochrome + one accent.** Red is rationed — used to mark *intent*
(play, hover, "now", primary action), never as decoration. If everything is red,
nothing is.

> Accessibility note: `#D60001` on `#0A0A0A` ≈ 4.3:1 — fine for large/bold text and
> UI glyphs, **below 4.5:1 for small body text**. Use red for large type, icons,
> and accents; keep small body copy off-white. Pair red fills with white text.

## Typography

- **Family:** clean grotesque / neo-grotesque sans-serif (e.g. Helvetica Now,
  Suisse Int'l, Neue Haas Grotesk, Inter as a free stand-in).
- **Treatment:** sparse and confident. Oversized cinematic display headings;
  generous letter-spacing on small uppercase labels (nav, metadata, credits).
- **Hierarchy by scale & weight, not color** — huge display vs. tiny tracked-out
  caption; very few intermediate sizes.
- **Numerals:** tabular for timecodes / indices (01 / 02 / 03 project numbering).

## Layout & Grid

- Full-bleed, edge-to-edge video frames; minimal chrome around content.
- Asymmetric, editorial composition with deliberate negative space — not a
  uniform card grid.
- Fixed/floating minimal nav; index-style project listing (numbered).
- Mobile: stack to a single column, preserve full-bleed media, keep the red accent.

## Motion & Interaction (the signature)

This is the differentiator — motion scored highest (7.80).

- **Custom cursor:** a bespoke cursor that morphs on hover (grows, shows "play"/
  "view", magnetic snap to interactive targets). The cursor *is* the affordance.
- **Page transitions:** smooth cover/reveal transitions between routes (wipe or
  fade through the dark canvas) — spatial continuity, never a hard cut.
- **Animated loader:** branded intro loader sets the cinematic tone before reveal.
- **Video player:** custom controls with animated play/scrub states.
- **Dynamic nav menu:** animated open/close overlay menu.
- Easing: smooth, weighted ease-in-out / spring; durations felt-but-fast.
  Respect `prefers-reduced-motion` — disable cursor morph & transitions, keep content.

## Imagery & Texture

- Video and film stills are the entire surface — high-contrast, cinematic grade.
- No illustration, no decorative gradients, no shadows-as-decoration. The footage
  supplies the texture; the UI stays flat and out of the way.

## Tone / Mood

Sophisticated, bold, industrial, elegant. Restraint everywhere except motion and
the red accent. Reads like a film title sequence, not a SaaS landing page.

## Signature Techniques to Reproduce

1. Monochrome canvas + a single rationed accent (`#D60001`).
2. A custom, morphing, magnetic cursor as the primary affordance.
3. Full-bleed video heroes with route-level cover/reveal transitions.
4. Oversized grotesque display type beside tiny tracked-out uppercase metadata.
5. Numbered, index-style project listing.

## Do / Don't

- **Do** let media run full-bleed; keep UI chrome minimal and flat.
- **Do** ration red for intent (play, hover, primary CTA, "now").
- **Do** invest in transition/cursor motion — it carries the brand.
- **Don't** introduce a second accent color or decorative gradients/shadows.
- **Don't** use red for small body text (contrast); keep body off-white.
- **Don't** ship the motion without a `prefers-reduced-motion` fallback.

## Implementation Notes

- Observed stack: **Next.js + Tailwind + Prismic** (headless CMS).
- Motion: a JS animation lib (GSAP / Framer Motion) for cursor, transitions, loader.
- Use `transform`/`opacity` only for the transitions; reserve space for media to
  avoid CLS; lazy-load below-fold footage; serve poster frames + WebM/MP4.
