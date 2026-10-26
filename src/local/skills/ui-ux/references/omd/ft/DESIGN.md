---
name: Financial Times
colors:
  primary: '#0d7680'
  primary-hover: '#0a5e66'
  primary-pressed: '#052f33'
  link-hover: '#08474d'
  link-underline: '#cfd8d1'
  canvas: '#fff1e5'
  surface-light: '#fff7ef'
  wheat: '#f2dfce'
  black-10: '#e6d9ce'
  black-20: '#ccc1b7'
  foreground: '#33302e'
  support-text: '#4d4845'
  muted-text: '#807973'
  black-60: '#66605c'
  slate: '#262a33'
  muted-inverse: '#a8aaad'
  claret: '#990f3d'
  oxford: '#0f5499'
  ft-pink: '#fcd0b1'
  crimson: '#cc0000'
  velvet: '#593380'
  mandarin: '#ff8833'
  jade: '#00994d'
  sky: '#cce6ff'
  success: '#00572c'
  success-surface: '#d7f0d1'
  white: '#ffffff'
typography:
  detail:
    fontSize: 14px
    use: '--o3-type-detail and -label; 66 text elements'
  body:
    fontSize: 16px
    use: '--o3-type-body-base; 116 text elements, the dominant size'
  body-lg:
    fontSize: 18px
    use: '--o3-type-body-lg'
  headline-sm:
    fontSize: 20px
    use: '--o3-type-headline-sm / title-sm; Financier Display story headlines, 54 elements'
  title-md:
    fontSize: 24px
    use: '--o3-type-title-md'
  title-lg:
    fontSize: 28px
    use: '--o3-type-title-lg'
  display-sm:
    fontSize: 32px
    use: '--o3-type-display-sm / headline-md'
  display-md:
    fontSize: 40px
    use: '--o3-type-display-md / headline-lg'
  display-lg:
    fontSize: 48px
    use: '--o3-type-display-lg, the largest use-case size'
rounded:
  xs: 2px
  sm: 3px
  md: 4px
spacing:
  5xs: 4
  4xs: 8
  3xs: 12
  2xs: 16
  xs: 20
  s: 24
  m: 32
  l: 40
  xl: 48
  2xl: 64
  3xl: 80
  4xl: 96
components:
  button-subscribe:
    type: button
    backgroundColor: '#262a33'
    textColor: '#ffffff'
    rounded: 2px
    height: 28px
    padding: 0 8px
    typography: 12px / 700
    focus: 'ring 0 0 0 4px #ffffff, 0 0 0 8px #4d4845'
    use: Subscribe in the header — slate with white Metric. Focus draws a two-layer authored ring, white inside black-70. Hover was not measured.
    pressed: 'bg #727071 (:hover + :active)'
  button-offers:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#262a33'
    rounded: 2px
    height: 44px
    padding: 0 16px
    typography: 16px / 700
    focus: 'ring 0 0 0 4px #4d4845, 0 0 0 8px #ffffff'
    use: 'Explore offers — the inverse button, white on a dark band. Its focus ring inverts too: black-70 inside, white outside. Hover was not measured.'
  link-signin:
    type: button
    backgroundColor: transparent
    textColor: '#33302e'
    height: 48px
    padding: 8px 0
    typography: 14px / 400
    focus: 'ring 0 0 0 2px #807973'
    use: Sign In in the header. Focus draws a 2px ring in the muted-text colour. Hover was not measured.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#33302e'
    height: 36px
    padding: 8px 0
    typography: 12px / 600
    focus: 'ring 0 0 0 2px #807973'
    use: 'Section navigation (WORLD, COMPANIES …). The current section, HOME, is set in #0a5e66. Focus draws the same 2px ring. Hover was not measured.'
fonts:
  roles:
    sans: Metric
    display: Financier Display
---

# Financial Times

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Financial Times; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/ft/DESIGN.md
