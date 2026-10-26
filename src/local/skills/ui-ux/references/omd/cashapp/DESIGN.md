---
name: Cash App
colors:
  primary: '#00e013'
  primary-tint: '#f9fffa'
  citron: '#d8ff14'
  ink: '#000000'
  canvas: '#ffffff'
  on-primary: '#000000'
  on-dark: '#ffffff'
  slate: '#27455c'
  blue-accent: '#3860be'
  surface: '#f8f8f8'
  surface-alt: '#f6f6f6'
  muted: '#737373'
  muted-strong: '#555555'
  muted-soft: '#999999'
  portal-grey: '#858585'
typography:
  display-hero:
    fontSize: 86px
    fontWeight: 400
    lineHeight: 1
    use: Brand-portal oversized section index labels, Cash Sans
  section:
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.1
    use: Marketing section headlines, Cash Sans Medium
  subsection:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.2
    use: Feature card heads, Cash Sans Medium
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, Cash Sans Regular
  nav:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    use: Portal nav / active labels, Cash Sans Semibold
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    use: Pill button label, Cash Sans Medium
  button-sm:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1
    use: Compact header pill label, Cash Sans Medium
rounded:
  sm: 2px
  md: 20px
  lg: 999px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 31
  xxl: 48
  section: 64
components:
  button-green:
    type: button
    backgroundColor: '#00e013'
    textColor: '#000000'
    rounded: 999px
    padding: 0 20px
    height: 46px
    typography: 14px / 500 Cash Sans
    use: Primary CTA (Sign up) — Cash Green hero action
  button-dark:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 999px
    padding: 0 20px
    height: 46px
    typography: 14px / 400 Cash Sans
    use: Log in pill on light surfaces
  button-light:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 999px
    padding: 0 20px
    height: 46px
    typography: 12px / 500 Cash Sans
    use: Sign up pill on dark hero
  nav-tab:
    type: tab
    textColor: '#000000'
    typography: 16px / 600 Cash Sans
    use: Top nav item
    active: 'Cash Green #00e013 underline / fill on hover'
  portal-nav-tab:
    type: tab
    textColor: '#ffffff'
    typography: 16px / 400 Cash Sans
    use: Brand-portal section nav on black canvas
    active: 'text #ffffff opaque (vs rgba 0.7 inactive)'
  card-light:
    type: card
    backgroundColor: '#f8f8f8'
    textColor: '#000000'
    rounded: 20px
    use: Light feature card on marketing surface (flat, no shadow)
  card-dark:
    type: card
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 20px
    use: Dark feature card / brand-portal tile
  badge-citron:
    type: badge
    backgroundColor: '#d8ff14'
    textColor: '#000000'
    rounded: 9999px
    typography: 12px / 500 Cash Sans
    use: High-impact accent chip (sparing, never full-bg)
  avatar-round:
    type: avatar
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 50%
    use: Circular account / profile control in header
fonts:
  roles:
    display: Cash Sans
    body: Cash Sans
    fallback: Helvetica Neue
---

# Cash App

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cash App; reproduced for educational reference. Full prose: https://oh-my-design.kr/cashapp/design.md
