---
name: Selectstar
colors:
  primary: '#0c5fdb'
  primary-hover: '#1274e7'
  accent-blue: '#5797f6'
  sky: '#6ec1e4'
  canvas: '#ffffff'
  surface: '#f8f9fa'
  surface-alt: '#e9ecef'
  ink: '#212529'
  slate: '#495057'
  body: '#6c757d'
  muted: '#adb5bd'
  black: '#000000'
  navy: '#00001a'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 300
    lineHeight: 1.25
    letterSpacing: '-1.44px'
    use: English hero headline, Inter Light — 'Solution for Trustworthy AI'
  display:
    fontSize: 60px
    fontWeight: 600
    lineHeight: 1.28
    letterSpacing: '-1.2px'
    use: Product / blog hero display
  section:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.28
    letterSpacing: '-0.96px'
    use: Section titles
  subsection:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.28
    letterSpacing: '-0.72px'
    use: Feature / sub-section heads
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.8
    use: Standard reading text, muted grey
  nav:
    fontSize: 16px
    fontWeight: 600
    use: Top-level nav items
  button:
    fontSize: 14px
    fontWeight: 600
    use: Header CTA / dropdown nav label
rounded:
  sm: 4px
  md: 10px
  lg: 24px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 18
  xl: 24
  xxl: 38
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#0c5fdb'
    textColor: '#ffffff'
    rounded: 4px
    height: 45px
    padding: 9px 18px
    typography: 14px / 600 Inter
    states: 'hover #1274e7'
    use: Header/primary CTA — 문의하기 / CONTACT
  button-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 50px
    padding: 16px 38px
    height: 64px
    typography: 20px / 400 Inter
    shadow: rgba(0,0,0,0.1) 0px 8px 19.2px
    use: Floating white pill CTA — 문의하기
  button-rounded:
    type: button
    backgroundColor: '#0c5fdb'
    textColor: '#ffffff'
    rounded: 26px
    padding: 10px 24px
    height: 50px
    typography: 16px / 400 Inter
    use: Newsletter Subscribe rounded CTA
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    padding: 9px 18px
    height: 47px
    typography: 16px Inter
    use: Blog search field, paired with blue Search button
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    shadow: rgba(0,0,0,0.15) 0px 3px 8px
    use: Feature / content card on grey canvas
  nav-link:
    type: tab
    textColor: '#212529'
    typography: 14px / 600 Inter
    active: 'text #0c5fdb'
    use: Product dropdown / nav menu item
  tint-surface:
    type: card
    backgroundColor: '#5797f6'
    textColor: '#0c5fdb'
    rounded: 10px
    use: 'Light-blue tinted highlight surface, rendered at 15% alpha (base #5797f6)'
  icon-chip:
    type: badge
    backgroundColor: '#e9ecef'
    textColor: '#0c5fdb'
    rounded: 9999px
    height: 50px
    use: Circular icon chip / carousel control
fonts:
  roles:
    sans: Inter
    kr: Noto Sans KR
---

# Selectstar

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Selectstar; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/selectstar/DESIGN.md
