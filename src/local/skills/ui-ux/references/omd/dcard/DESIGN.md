---
name: Dcard
colors:
  primary: '#3397cf'
  primary-hover: '#5ab0db'
  secondary: '#006aa6'
  brand: '#00324e'
  canvas: '#f2f2f2'
  surface: '#ffffff'
  foreground: '#000000'
  on-primary: '#ffffff'
  hint: '#e7f3f9'
  premium: '#ffc51b'
  premium-hover: '#ffd558'
  success: '#49bd69'
  danger: '#ea5c5c'
  warning: '#f0a955'
  special: '#f0b941'
  topic: '#bf8ff0'
  snackbar: '#2c2c2c'
  sidebar-hover: '#032133'
  disabled: '#e0e0e0'
  hairline: '#cacaca'
  gender-female: '#cb3a6b'
  gender-male: '#1c7fac'
typography:
  headline-1:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.31
    use: Top headline tier (mobile 30px)
  headline-2:
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.43
    use: Second headline tier
  headline-3:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.17
    use: Third headline tier
  headline-4:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.4
    use: Smallest headline tier
  title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.39
    use: Section headers in modals/editors (only 600 tier)
  subtitle:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.38
    use: Subtitle 1
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.38
    use: Body 1, standard reading
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Body 2
  caption:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.42
    use: Caption — bumps to 500 for small-size legibility
  caption-sm:
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.6
    use: Caption 2, smallest
rounded:
  sm: 4px
  md: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 20
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#3397cf'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 20px
    typography: 14/500
    use: Hero Download App CTA
  button-secondary:
    type: button
    backgroundColor: '#006aa6'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 20px
    typography: 14/500
    use: Search submit, joined to input
  button-counter:
    type: button
    rounded: 8px
    padding: 1px 14px
    typography: 14/500
    use: Like / comment counters
  button-disabled:
    type: button
    backgroundColor: '#e0e0e0'
    rounded: 8px
    use: Inactive button state
  search-input:
    type: input
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 8px 12px
    use: 'Header search, 1px #cacaca border, joined to submit'
  post-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 20px
    use: 'Main feed post card on #f2f2f2 gray bg, contrast handles separation'
  forum-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 16px
    use: Forum directory card, 146x110px
  topic-chip:
    type: badge
    backgroundColor: '#bf8ff0'
    textColor: '#ffffff'
    rounded: 4px
    padding: 4px 8px
    typography: 12/500
    use: Topic tags — lavender accent
  sponsor-chip:
    type: badge
    backgroundColor: '#f0b941'
    textColor: '#ffffff'
    rounded: 4px
    padding: 4px 8px
    use: Sponsored / special-promotion chips
  feed-tabs:
    type: tab
    rounded: 4px
    use: All / Following switcher, 48px header
    active: 'underline indicator + #000000 text'
  snackbar:
    type: toast
    backgroundColor: '#2c2c2c'
    textColor: '#ffffff'
    rounded: 4px
    use: Toast notification, 250px wide
fonts:
  roles:
    sans: Roboto
---

# Dcard

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Dcard; reproduced for educational reference. Full prose: https://oh-my-design.kr/dcard/design.md
