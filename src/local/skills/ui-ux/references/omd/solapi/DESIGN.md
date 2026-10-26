---
name: SOLAPI
colors:
  primary: '#4541ff'
  primary-light: '#a788ff'
  ink: '#222222'
  heading: '#333333'
  slate-ink: '#111827'
  muted: '#828282'
  slate-muted: '#64748b'
  link: '#2563eb'
  success: '#28c840'
  canvas: '#ffffff'
  surface: '#f8fafc'
  input-bg: '#f9f9f9'
  hairline: '#e5e8eb'
  border-slate: '#e2e8f0'
  code-ink: '#24292f'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 800
    lineHeight: 1.18
    use: Homepage hero headline, Pretendard ExtraBold
  display:
    fontSize: 52px
    fontWeight: 800
    lineHeight: 1.2
    use: Section marketing headlines
  headline:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.2
    use: Developers section heads
  title:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.3
    use: Pricing table / sub-section titles
  subsection:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    use: Feature card heads
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.55
    use: Lead paragraph / problem statements
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
    use: Standard reading + nav links
  button:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    use: Header CTA / nav button label
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Footer, fine print, utility links
  code:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
    use: SDK snippets, Monaco/Menlo mono
rounded:
  xs: 5px
  sm: 6px
  md: 8px
  base: 12px
  card: 20px
  pill: 100px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 28
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#4541ff'
    textColor: '#ffffff'
    border: '1px solid #4541ff'
    rounded: 8px
    padding: 14px 32px
    height: 50px
    typography: 17px / 600
    states: header variant radius 5px · developers variant radius 12px
    use: Primary CTA — 시작하기 / 솔라피 가입하기 / 시작하기 →
  button-pill-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#4541ff'
    border: '1px solid #4541ff'
    rounded: 100px
    padding: 16px 32px
    typography: 16px / 800
    use: Enterprise-inquiry pill — 도입 문의하기
  button-ghost-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111827'
    border: '1px solid #e2e8f0'
    rounded: 8px
    padding: 14px 32px
    typography: 17px / 600
    use: Secondary CTA — 데모 체험하기
  input-search:
    type: input
    backgroundColor: '#f9f9f9'
    textColor: '#222222'
    border: '1px solid #e5e8eb'
    rounded: 14px
    padding: 12px 44px
    height: 45px
    typography: 16px / 400
    use: Pricing / docs search field
  card-pricing:
    type: card
    backgroundColor: '#f8fafc'
    textColor: '#111827'
    border: '1px solid #e2e8f0'
    rounded: 10px
    shadow: rgba(0,0,0,0.1) 0px 0px 16px 0px
    use: Pricing + discount-table linked card
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    rounded: 20px
    shadow: rgba(69,65,255,0.2) 0px 0px 20px 0px
    use: Feature card, 20px workhorse radius + brand-glow
  nav-link:
    type: tab
    textColor: '#222222'
    typography: 16px / 400
    active: 'text #4541ff on active'
    use: Top nav item — 가이드 / SDK / API
  code-block:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#24292f'
    rounded: 12px
    typography: 14px / 400 Monaco
    use: Developers SDK snippet panel
  badge-success:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#28c840'
    border: '1px solid #e2e8f0'
    rounded: 6px
    typography: 13px / 700
    use: Status / success indicator pill
fonts:
  roles:
    sans: Pretendard
    mono: Monaco
---

# SOLAPI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SOLAPI; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/solapi/DESIGN.md
