---
name: Beusable
colors:
  primary: '#ec0047'
  primary-hover: '#ff1553'
  accent: '#00b7ff'
  teal: '#13a5bf'
  teal-alt: '#16b5d2'
  data-yellow: '#f6e136'
  ink: '#000000'
  heading: '#2f2f2f'
  heading-strong: '#222222'
  body: '#444444'
  border-strong: '#666666'
  muted: '#777777'
  muted-alt: '#999999'
  faint: '#b1b1b1'
  faint-alt: '#cccccc'
  canvas: '#ffffff'
  surface-dark: '#181818'
  tint-cyan: '#e0f6fa'
  hairline: '#ebebeb'
  hairline-alt: '#d9d9d9'
typography:
  display-hero:
    fontSize: 65px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-1.5px'
    use: English display H1, NewRubrik
  section:
    fontSize: 55px
    fontWeight: 700
    lineHeight: 1.31
    letterSpacing: '-1px'
    use: Korean section headline, Pretendard
  nav:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    use: Top nav links, Pretendard
  button:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    use: CTA / Get Started label
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Sub-nav / dropdown menu labels
rounded:
  sm: 4px
  md: 5px
  lg: 21px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 18
  xl: 28
  xxl: 32
components:
  cta-primary:
    type: button
    backgroundColor: '#ec0047'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 8px 16px
    height: 38px
    typography: 14px / 700 Pretendard Variable
    states: 'hover #ff1553'
    use: Primary Get Started CTA, full pill
  button-outline-light:
    type: button
    textColor: '#222222'
    border: '1px solid #666666'
    rounded: 21px
    padding: 10px 18px
    height: 38px
    typography: 14px / 700 Pretendard Variable
    use: Sign In / secondary action on white surface
  hero-glass-pill:
    type: button
    textColor: '#00b7ff'
    rounded: 9999px
    padding: 0 28px
    height: 60px
    typography: 16px / 400 Pretendard Variable
    use: Hero glass CTA on dark band, translucent bg + white hairline border
  filter-tag:
    type: badge
    textColor: '#ec0047'
    border: '1px solid #ec0047'
    rounded: 5px
    padding: 4px 10px
    typography: 14px / 500 Pretendard Variable
    use: Feature filter / section tag
  nav-menu-item:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#444444'
    rounded: 4px
    padding: 6px 10px
    typography: 14px / 400 Pretendard Variable
    states: 'active #ec0047'
    use: Feature dropdown menu row
  tinted-card:
    type: card
    backgroundColor: '#e0f6fa'
    textColor: '#222222'
    rounded: 20px
    use: Soft cyan-tinted feature card
  back-fab:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#00b7ff'
    rounded: 20px
    padding: 9px 15px
    shadow: rgba(0,0,0,0.05) 0px 9px 11px -5px
    typography: 16px / 400 Pretendard Variable
    use: Floating back button on feature pages
  data-marker:
    type: badge
    backgroundColor: '#f6e136'
    textColor: '#000000'
    rounded: 9999px
    use: Heatmap warm-zone data marker
fonts:
  roles:
    display: NewRubrik
    body: Pretendard Variable
---

# Beusable

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Beusable; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/beusable/DESIGN.md
