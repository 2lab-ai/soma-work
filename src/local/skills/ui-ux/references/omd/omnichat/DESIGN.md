---
name: Omnichat
colors:
  primary: '#006aff'
  action: '#408fff'
  deep: '#0202a6'
  gradient-base: '#3337f6'
  gradient-sky: '#379afd'
  gradient-mint: '#69dfb2'
  gradient-lavender: '#ac9cff'
  gradient-violet: '#8e4dff'
  heading-sky: '#4e97ff'
  heading-sky-soft: '#75adfc'
  hero-sub: '#8ca8cf'
  ink: '#333333'
  ink-strong: '#2e2e2e'
  ink-heading: '#3d3d3d'
  muted: '#666666'
  icon-grey: '#69727d'
  canvas: '#ffffff'
  surface: '#f8f9fa'
  surface-alt: '#f9f9f9'
  tint-blue: '#ecf4ff'
  tint-blue-deep: '#d9e8ff'
  hero-dark: '#000000'
  input-border: '#c5c5c5'
  menu-accent: '#cc3366'
typography:
  display-hero:
    fontSize: 52px
    fontWeight: 500
    lineHeight: 1.23
    letterSpacing: 1.4px
    use: Hero headline, aurora-gradient-clipped Outfit on black
  display-xl:
    fontSize: 46px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 1px
    use: Major section headlines on dark bands
  section:
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: 1px
    use: Section titles (deep blue or ink)
  feature:
    fontSize: 34px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 1px
    use: Feature / case-study headings
  card-head:
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 1px
    use: Card and capability heads
  plan-head:
    fontSize: 24px
    fontWeight: 500
    letterSpacing: 1px
    use: Pricing plan names
  nav:
    fontSize: 17px
    fontWeight: 400
    use: Top navigation items
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body copy, buttons, badges
  menu-item:
    fontSize: 14px
    fontWeight: 500
    use: Mega-menu dropdown links
rounded:
  sm: 5px
  md: 10px
  lg: 20px
  full: 99px
spacing:
  xs: 3
  sm: 8
  md: 10
  base: 16
  lg: 20
  xl: 27
  xxl: 36
components:
  button-primary:
    type: button
    backgroundColor: '#006aff'
    textColor: '#ffffff'
    border: '1px solid #006aff'
    rounded: 13px 13px 0px
    height: 32px
    typography: 16px / 500
    use: Header 專家諮詢 CTA — notched bottom-right corner
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#006aff'
    border: '1px solid #006aff'
    rounded: 13px 13px 0px
    height: 32px
    typography: 16px / 500
    use: Header 免費試用 secondary CTA, same notched geometry
  button-gradient:
    type: button
    backgroundColor: '#3337f6'
    textColor: '#ffffff'
    rounded: 10px
    height: 44px
    padding: 10px
    typography: 16px / 500
    states: 'animated 270deg gradient #3337f6 → #379afd → #69dfb2'
    use: Hero 專家諮詢 CTA on black
  button-action:
    type: button
    backgroundColor: '#408fff'
    textColor: '#ffffff'
    rounded: 0px 24px
    height: 45px
    padding: 8px 20px 11px
    typography: 16px / 500
    use: 聯絡專人 / 送出資料 ribbon CTA — opposing corners rounded
  segment-toggle:
    type: tab
    textColor: '#408fff'
    active: 'bg #408fff + text #ffffff'
    rounded: 99px
    height: 36px
    typography: 16px / 500
    use: Pricing product switcher pill (線上對話商務 / OMO / Social CDP)
  input-default:
    type: input
    backgroundColor: '#f9f9f9'
    textColor: '#3d3d3d'
    border: '1px solid #c5c5c5'
    rounded: 8px
    height: 44px
    padding: 8px 16px
    typography: 16px / 400
    use: Lead-form text field
  card-pricing:
    type: card
    backgroundColor: '#ffffff'
    border: '2px solid #006aff'
    rounded: 20px
    padding: 36px 26px
    shadow: rgba(0,0,0,0.06) 3px 3px 15px
    use: 'Featured plan card; non-featured plans carry an invisible 2px #ffffff border'
  badge-popular:
    type: badge
    backgroundColor: '#006aff'
    textColor: '#ffffff'
    rounded: 5px
    padding: 1px 32px
    height: 28px
    typography: 16px / 400
    use: 最受歡迎 plan ribbon
fonts:
  roles:
    display: Outfit
    zh: Noto Sans HK
---

# Omnichat

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Omnichat; reproduced for educational reference. Full prose: https://oh-my-design.kr/omnichat/design.md
