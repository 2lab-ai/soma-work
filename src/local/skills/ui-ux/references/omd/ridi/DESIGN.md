---
name: RIDI
colors:
  charcoal: '#3d3d3d'
  ink: '#222222'
  white: '#ffffff'
  blue: '#1f8ce6'
  fg-secondary: '#5d5d5d'
  fg-tertiary: '#9d9d9d'
  fg-disabled: '#b5b5b5'
  subtle: '#f9f9f9'
  stroke: '#d0d0d0'
  critical: '#f4361e'
  positive: '#03aa5a'
  highlight-cream: '#fff9ea'
  sepia: '#f4ecd8'
  night: '#1a1a1a'
  reader-night-fg: '#d8d8d8'
  disabled-bg: '#f0f0f0'
typography:
  display:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    use: Section banners, hero
  heading-lg:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.36
    use: Shelf titles
  heading:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.44
    use: Modal titles, expanded BookCard title
  title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.38
    use: BookCard title, nav active label
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Primary body, button label
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Author, publisher, metadata
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Ratings, review counts, page counts
  caption-sm:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Timestamps, footer chrome, badge text
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#3d3d3d'
    textColor: '#f9f9f9'
    rounded: 8px
    padding: 10px 16px
    typography: 16/400
    use: 'Brand solid CTA (로그인, 구독하기); pressed #222222, disabled #f0f0f0/#b5b5b5'
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#222222'
    rounded: 8px
    use: 'Neutral outline secondary, 1px #d0d0d0 border'
  sale-tag:
    type: badge
    backgroundColor: '#f4361e'
    textColor: '#ffffff'
    rounded: 4px
    use: Inline price discount flag (chip, not CTA)
  button-subscription:
    type: button
    backgroundColor: '#1f8ce6'
    textColor: '#ffffff'
    rounded: 8px
    use: RIDI Select / Manta CTA
  book-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 12px
    padding: 4px 0
    use: Iconic cover-art tile, 2:3 cover at 4px, two-layer shadow
  chip:
    type: badge
    backgroundColor: '#f9f9f9'
    textColor: '#222222'
    rounded: 9999px
    padding: 0 12px
    typography: 13/500
    use: Genre filter
    active: '#222222 bg, #ffffff text'
  input:
    type: input
    backgroundColor: '#f9f9f9'
    textColor: '#222222'
    rounded: 8px
    use: 'Form input, 1px #d0d0d0 border, #1f8ce6 focus ring'
  nav-top:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#5d5d5d'
    use: Top bar, 64px
    active: '#222222 weight 700'
  subscribed-badge:
    type: badge
    backgroundColor: '#03aa5a'
    textColor: '#ffffff'
    rounded: 9999px
    use: 구독 중 pill on eligible cards
fonts:
  roles:
    sans: Pretendard Std
    mono: SF Mono
---

# RIDI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to RIDI; reproduced for educational reference. Full prose: https://oh-my-design.kr/ridi/design.md
