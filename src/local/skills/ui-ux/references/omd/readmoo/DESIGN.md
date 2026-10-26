---
name: Readmoo
colors:
  primary: '#40c8f7'
  primary-hover: '#0092c2'
  primary-tint: '#c2f0ff'
  secondary: '#e98192'
  canvas: '#fafafa'
  surface: '#ffffff'
  surface-grey: '#f2f2f2'
  surface-grey-alt: '#e8e8e8'
  ink: '#212529'
  navy: '#013253'
  body: '#4a4a4a'
  text-dark: '#343a40'
  muted: '#666666'
  muted-grey: '#808080'
  faint: '#9b9b9b'
  hairline: '#dddfe1'
  sale: '#dc3545'
  success: '#28a745'
  highlight: '#f8b62d'
  on-primary: '#ffffff'
typography:
  product-hero:
    fontSize: 44px
    fontWeight: 700
    lineHeight: 1.2
    use: mooInk product page H1, PingFangTC bold
  section:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.2
    use: Section headings (每分鐘…), PingFangTC bold
  store-h1:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.2
    use: Store hero H1, PingFangTC regular
  subsection:
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.2
    use: Sub-section heads (保固說明), PingFangTC medium
  category-nav:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.2
    use: Store category tabs (書籍/雜誌), Songti TC serif
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, PingFangTC
  label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Secondary nav, advanced-search toggle
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Social activity feed, fine print
rounded:
  sm: 3px
  md: 4px
  lg: 25px
  full: 9999px
spacing:
  xs: 4
  sm: 6
  md: 8
  base: 12
  lg: 16
  xl: 24
  xxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#40c8f7'
    textColor: '#ffffff'
    rounded: 25px
    padding: 6px 12px
    height: 38px
    border: '1px solid #40c8f7'
    typography: 16px / 400 PingFangTC
    states: 'hover #0092c2'
    use: Primary CTA pill (了解更多, 查看更多, mooInk 詳細介紹)
  button-register:
    type: button
    backgroundColor: '#40c8f7'
    textColor: '#ffffff'
    rounded: 3px
    padding: 0 10px
    height: 32px
    typography: 16px / 700 PingFangTC
    use: Header register (註冊) — sharp-corner accent
  button-secondary:
    type: button
    backgroundColor: '#e98192'
    textColor: '#ffffff'
    rounded: 25px
    padding: 6px 12px
    height: 38px
    border: '1px solid #e98192'
    typography: 16px / 400 PingFangTC
    use: Secondary commerce action (mooInk 優惠套組 / cart)
  button-grey:
    type: button
    backgroundColor: '#f2f2f2'
    textColor: '#333333'
    rounded: 25px
    padding: 6px 12px
    height: 38px
    typography: 16px / 400 PingFangTC
    use: Tertiary pill (規格比較, 展售店家, FAQ) — also rendered as translucent rgba(0,0,0,0.05)
  search-button:
    type: button
    backgroundColor: '#40c8f7'
    textColor: '#ffffff'
    rounded: 0 4px 4px 0
    padding: 6px 16px
    height: 40px
    typography: 16px / 400 PingFangTC
    use: Search submit, fused to input right edge
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px 0 0 4px
    padding: 8px 12px
    height: 40px
    border: '1px solid #dddfe1'
    typography: 16px / 400 PingFangTC
    use: Store search field
  category-tab:
    type: tab
    textColor: '#666666'
    typography: 20px / 700 Songti TC
    rounded: 4px 4px 0 0
    active: 'text #333333 + bg #f2f2f2 + 2px bottom border #40c8f7'
    use: Store category tabs (書籍/雜誌/有聲書/漫畫) — serif
  feature-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#212529'
    rounded: 4px
    border: '1px solid #dddfe1'
    use: Book / feature card on store + mooInk grid
  tint-card:
    type: card
    backgroundColor: '#c2f0ff'
    textColor: '#212529'
    rounded: 4px
    use: Cyan-tint highlight panel (mooInk feature callout)
  sale-badge:
    type: badge
    backgroundColor: '#dc3545'
    textColor: '#ffffff'
    rounded: 3px
    padding: 1px 6px
    typography: 13px / 400 PingFangTC
    use: Discount / sale tag on book covers
  stock-badge:
    type: badge
    backgroundColor: '#28a745'
    textColor: '#ffffff'
    rounded: 3px
    padding: 1px 6px
    typography: 13px / 400 PingFangTC
    use: In-stock / availability tag
fonts:
  roles:
    sans: PingFangTC-Regular, Microsoft JhengHei, Helvetica Neue, Heiti TC
    serif: Songti TC
---

# Readmoo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Readmoo; reproduced for educational reference. Full prose: https://oh-my-design.kr/readmoo/design.md
