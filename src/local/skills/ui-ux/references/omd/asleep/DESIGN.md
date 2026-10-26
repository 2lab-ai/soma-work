---
name: Asleep
colors:
  primary: '#2a75fc'
  accent-docs: '#3a61f2'
  info: '#118cfd'
  canvas-dark: '#121212'
  canvas: '#ffffff'
  on-dark: '#ffffff'
  ink: '#222222'
  body: '#333333'
  muted: '#444e57'
  black: '#000000'
typography:
  display-hero:
    fontSize: 52px
    fontWeight: 600
    lineHeight: 1.31
    use: Hero headline, Pretendard SemiBold on dark
  section:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.3
    use: Section titles
  nav:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.3
    use: Top nav items on dark header
  button:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.2
    use: CTA button label
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Body text, 20px line-height
  docs-nav:
    fontSize: 14px
    fontWeight: 450
    lineHeight: 1.43
    use: Docs sidebar navigation row
rounded:
  none: 0px
  sm: 6px
  md: 8px
  lg: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  base: 10
  md: 12
  lg: 20
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#2a75fc'
    textColor: '#ffffff'
    rounded: 0px
    padding: 8px 12px
    typography: 16px / 400 Pretendard
    use: Marketing primary CTA (API 도입 문의하기) — sharp-edged electric blue
  button-outline:
    type: button
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 0px
    padding: 8px 12px
    typography: 16px / 400 Pretendard
    use: Marketing secondary CTA (API Docs) outlined on dark hero
  nav-link:
    type: tab
    textColor: '#ffffff'
    typography: 18px / 400 Pretendard
    active: 'text #2a75fc'
    use: 'Top nav item on dark #121212 header'
  docs-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 6px
    typography: 13px / 400 Pretendard
    use: Docs search field (⌘K) on the light docs surface
  docs-nav-item:
    type: listItem
    textColor: '#444e57'
    rounded: 8px
    typography: 14px / 450 Pretendard
    active: bg rgba(255,255,255,0.1)
    use: Docs sidebar navigation row
  docs-callout:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #118cfd'
    rounded: 6px
    use: Docs info callout / content card with a blue accent edge
fonts:
  roles:
    sans: Pretendard Variable
---

# Asleep

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Asleep; reproduced for educational reference. Full prose: https://oh-my-design.kr/asleep/design.md
