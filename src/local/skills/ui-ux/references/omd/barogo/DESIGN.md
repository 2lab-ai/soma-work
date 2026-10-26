---
name: Barogo
colors:
  primary: '#fa5014'
  ink: '#000000'
  ink-soft: '#111111'
  body: '#666666'
  muted: '#999999'
  hairline: '#dcdcdc'
  canvas: '#ffffff'
  surface: '#f6f6f6'
  surface-alt: '#f9f9f9'
  dark: '#1a1a1a'
  accent-blue: '#2d3ce6'
  on-primary: '#ffffff'
typography:
  mission-hero:
    fontSize: 54px
    fontWeight: 700
    lineHeight: 1.33
    use: About-page mission headline, Pretendard Bold
  hero:
    fontSize: 42px
    fontWeight: 700
    lineHeight: 1.43
    use: Homepage hero + section titles, Pretendard Bold
  stat-numeral:
    fontSize: 150px
    fontWeight: 700
    use: 'Ghosted background year numerals (Termina), color #000000 at 0.05 alpha'
  subsection:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1
    use: Sub-section heads / stat block labels
  nav:
    fontSize: 20px
    fontWeight: 500
    use: Top nav item, Pretendard (700 when active)
  button:
    fontSize: 20px
    fontWeight: 700
    use: Primary CTA label, Pretendard Bold
  button-sm:
    fontSize: 18px
    fontWeight: 700
    use: Outline button label, Pretendard Bold
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Standard reading / UI text, Pretendard
  caption:
    fontSize: 12px
    fontWeight: 500
    use: Footer links, Pretendard
rounded:
  sm: 3px
  md: 12px
  lg: 16px
  xl: 20px
  full: 9999px
spacing:
  xs: 8
  sm: 12
  md: 16
  base: 20
  lg: 30
  xl: 40
  xxl: 50
components:
  button-primary:
    type: button
    backgroundColor: '#fa5014'
    textColor: '#ffffff'
    rounded: 3px
    height: 72px
    padding: 0 40px
    typography: 20px / 700 Pretendard
    shadow: rgba(0,0,0,0.2) 0px 2px 10px
    use: Primary CTA — 바로 문의하기
  button-outline:
    type: button
    textColor: '#fa5014'
    border: '1px solid #fa5014'
    rounded: 3px
    height: 64px
    padding: 0 30px
    typography: 18px / 700 Pretendard
    use: Secondary outline action — 스토어프로그램 / 사용 설명서 / 자세히 보기
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 20px
    shadow: rgba(0,0,0,0.1) 0px 2px 20px
    use: Feature/info card grid on aboutUs
  card-stat:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 40px 32px
    shadow: rgba(0,0,0,0.1) 0px 2px 20px
    use: '''숫자로 보는 바로고'' statistic card'
  nav-link:
    type: tab
    textColor: '#000000'
    typography: 20px / 500 Pretendard
    active: 'weight 700 #000000'
    use: Top navigation item
  footer-link:
    type: listItem
    textColor: '#ffffff'
    typography: 12px / 500 Pretendard
    use: 'Footer navigation link on #1a1a1a dark footer'
fonts:
  roles:
    body: Pretendard
    display: Termina
---

# Barogo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Barogo; reproduced for educational reference. Full prose: https://oh-my-design.kr/barogo/design.md
