---
name: Gaudio Lab
colors:
  primary: '#00b7ff'
  ink: '#111214'
  canvas: '#ffffff'
  surface: '#f0f9ff'
  night: '#1e1e1f'
  ocean: '#12354e'
  muted: '#9ca3af'
  faint: '#d3d5da'
  hairline: '#d6d6d6'
  on-primary: '#fafafa'
typography:
  display-hero:
    fontSize: 80px
    fontWeight: 700
    lineHeight: 1
    use: Korean brand hero headline, system-ui / Noto Sans KR
  section:
    fontSize: 48px
    fontWeight: 900
    lineHeight: 1.46
    use: English section titles, black weight
  stat:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.11
    letterSpacing: 0.15px
    use: Milestone stat H1, Roboto
  card-title:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.56
    use: Blog/news card heading, Roboto
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body text, Roboto / MUI base
  nav:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    use: Top nav menu buttons, Roboto
  button-lg:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1
    use: '''Watch the Film'' overlay button, Poppins'
rounded:
  sm: 4px
  md: 6px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 40
  section: 64
components:
  cta-primary:
    type: button
    backgroundColor: '#00b7ff'
    textColor: '#fafafa'
    rounded: 6px
    padding: 8px 16px
    height: 32px
    typography: 14px / 500
    use: Header 'Contact us' / '문의하기' CTA
  cta-hero:
    type: button
    backgroundColor: '#00b7ff'
    textColor: '#ffffff'
    rounded: 4px
    height: 44px
    typography: 16px / 500
    use: Hero primary 'Contact us' CTA
  button-outline:
    type: button
    textColor: '#00b7ff'
    border: '1px solid #00b7ff'
    rounded: 4px
    height: 44px
    typography: 16px / 500
    use: '''All products'' secondary action'
  button-film:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111214'
    rounded: 4px
    padding: 16px 40px
    height: 62px
    typography: 18px / 500 Poppins
    use: '''Watch the Film'' overlay button on brand hero'
  nav-item:
    type: tab
    textColor: '#111214'
    rounded: 6px
    padding: 8px 16px
    typography: 14px / 500
    active: 'text #00b7ff'
    use: Top nav menu items (light surface)
  news-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #d6d6d6'
    rounded: 12px
    use: Blog & news thumbnail card, shadowless
  product-row:
    type: listItem
    textColor: '#111214'
    rounded: 9999px
    height: 64px
    typography: 16px / 400
    use: Product row in app-launcher menu
  app-launcher:
    type: button
    rounded: 9999px
    height: 40px
    use: Circular app-launcher icon button
fonts:
  roles:
    display: Poppins
    body: Roboto
    ko: Noto Sans KR
---

# Gaudio Lab

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Gaudio Lab; reproduced for educational reference. Full prose: https://oh-my-design.kr/gaudiolab/design.md
