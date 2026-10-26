---
name: Pairs
colors:
  primary: '#00c1d4'
  primary-link: '#0096a9'
  primary-strong: '#00aec2'
  primary-deep: '#007f90'
  primary-light: '#a5eaf5'
  primary-surface: '#e0f8fc'
  gradient-start: '#70dfab'
  gradient-mid: '#3bd6cb'
  gradient-end: '#20cfe3'
  ink: '#0a2c2f'
  foreground: '#325151'
  gray-02: '#678181'
  gray-03: '#96aaaa'
  border: '#dae4e5'
  gray-06: '#ebf2f2'
  surface: '#f4fbfb'
  canvas: '#ffffff'
  blue: '#007bcc'
  red: '#d03138'
  red-bright: '#ef3f45'
  green: '#028541'
  yellow: '#f1bf00'
  orange: '#ff8831'
  purple: '#6e7de2'
typography:
  caption-2:
    fontSize: 12px
    use: '--text-caption-2-pc (10px on -sp), 400, 150%'
  caption-1:
    fontSize: 14px
    use: '--text-caption-1-pc (10px on -sp), 400, 150%'
  body-2:
    fontSize: 16px
    use: '--text-body-2-pc (12px on -sp), 400, 150%; the header buttons at 700'
  body-1:
    fontSize: 18px
    use: '--text-body-1-pc (14px on -sp), 400, 150% — and body-1-wide at 200%'
  headline-3:
    fontSize: 22px
    use: '--text-headline-3-pc (16px on -sp), 700, 150%'
  headline-2:
    fontSize: 24px
    use: '--text-headline-2-pc (18px on -sp), 700, 130%'
  headline-1:
    fontSize: 38px
    use: '--text-headline-1-pc (28px on -sp), 700, 130%'
  headline-0:
    fontSize: 40px
    use: '--text-headline-0-pc (30px on -sp), 700, 130%'
rounded:
  lg: 16px
  xl: 24px
  pill: 9999px
components:
  button-signup:
    type: button
    backgroundColor: 'linear-gradient(90deg, #70dfab, #3bd6cb, #20cfe3)'
    textColor: '#ffffff'
    rounded: 9999px
    height: 36px
    typography: 16px / 700
    hover: '#ffffff, fg #00c1d4, border 2px #00c1d4'
    pressed: '#ffffff, fg #00c1d4, border 2px #00c1d4'
    use: 新規登録 in the header — white text on the brand gradient (the --color-pairs-gradient PNG; stops sampled from its pixels). Hover drops the gradient for white with a teal label and a 2px teal border. Focus is the browser's ring.
  button-cta-large:
    type: button
    backgroundColor: 'linear-gradient(90deg, #70dfab, #3bd6cb, #20cfe3)'
    textColor: '#ffffff'
    rounded: 90px
    height: 72px
    padding: 24px 0
    typography: 18px / 700
    hover: '#ffffff, fg #00c1d4, border 2px #00c1d4'
    pressed: '#ffffff, fg #00c1d4, border 2px #00c1d4'
    use: 今すぐ無料ではじめる, 307×72 — the same gradient and the same inversion on hover, at the large size.
  button-login:
    type: button
    backgroundColor: transparent
    textColor: '#00c1d4'
    border: '2px solid #00c1d4'
    rounded: 9999px
    height: 36px
    typography: 16px / 700
    hover: '#a5eaf5, fg #ffffff, border #a5eaf5'
    pressed: '#a5eaf5, fg #ffffff, border #a5eaf5'
    use: 'ログイン — the outline twin: teal border and label, filling with pale teal and turning the label white on hover.'
  card-testimonial:
    type: card
    backgroundColor: transparent
    textColor: '#000000'
    border: '#dae4e5'
    hover: transparent
    pressed: transparent
    use: Member testimonial cards (links). Nothing changes on hover or press — the seven compared values stay the same; only the browser's focus ring marks them.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Noto Sans JP
    latin: Roboto
---

# Pairs

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Pairs; reproduced for educational reference. Full prose: https://oh-my-design.kr/pairs/design.md
