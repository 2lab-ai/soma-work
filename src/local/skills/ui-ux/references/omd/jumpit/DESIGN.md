---
name: Jumpit
colors:
  brand: '#00dd6d'
  heading: '#000000'
  heading-soft: '#222222'
  body: '#444444'
  muted: '#888888'
  inverse: '#ffffff'
  canvas: '#ffffff'
  footer-plate: '#fbfbfb'
typography:
  hero-title:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.3
    use: Hero carousel card title over photo, white
  section-h3:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.3
    use: Section heading titles
  cta:
    fontSize: 15px
    fontWeight: 700
    use: Primary auth CTA label
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body, link, chip rest state
  chip-active:
    fontSize: 16px
    fontWeight: 700
    use: Active filter chip label
  footer-link:
    fontSize: 14px
    fontWeight: 400
    use: Footer nav link
  eyebrow:
    fontSize: 13px
    fontWeight: 700
    use: Brand Notice eyebrow, always green
rounded:
  sm: 8px
  md: 20px
  lg: 100px
  full: 9999px
spacing:
  xs: 8
  sm: 16
  md: 24
  base: 32
  lg: 40
components:
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 16px
    typography: 15px / 700
    use: 회원가입/로그인 auth CTA — black, never green
    hover: '#333333'
    pressed: '#333333'
  chip-role-active:
    type: badge
    backgroundColor: '#00dd6d'
    textColor: '#ffffff'
    rounded: 20px
    padding: 7px 16px
    typography: 16px / 700
    use: Single-selected job-role filter chip
  chip-role-rest:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#444444'
    rounded: 20px
    padding: 7px 16px
    typography: 16px / 400
    use: Unselected role chips in 22-chip filter row
  dropdown-filter:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 100px
    padding: 8px 30px 8px 12px
    typography: 16px / 400
    use: Outlined multi-select filter dropdown trigger
  card-hero:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#ffffff'
    rounded: 0px
    typography: 32px / 700
    use: Hero carousel promo card, full-bleed photo, no shadow, 340px tall
  card-job:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#444444'
    rounded: 0px
    use: Result-grid JobCard on /positions, no shadow, hairline border
  eyebrow-brand:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#00dd6d'
    typography: 13px / 700
    use: Notice eyebrow above announcement card
  heading-section:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#222222'
    typography: 24px / 700
    use: Section H3 title on canvas
  link-footer:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#444444'
    rounded: 0px
    typography: 14px / 400
    use: Footer nav link
  link-viewall:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#888888'
    typography: 16px / 400
    use: 전체 보기 inline affordance at section header edge
fonts:
  roles:
    sans: Pretendard Variable
    mono: Pretendard Variable
---

# Jumpit

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Jumpit; reproduced for educational reference. Full prose: https://oh-my-design.kr/jumpit/design.md
