---
name: Frip
colors:
  primary: '#7a29fa'
  accent: '#f4373d'
  sale: '#ff3f33'
  point: '#e21d47'
  pink-tint: '#fff4f7'
  ink: '#000000'
  charcoal: '#333333'
  near-black: '#111111'
  body: '#777777'
  muted: '#999999'
  faint: '#aaaaaa'
  canvas: '#ffffff'
  surface: '#fafafa'
  surface-alt: '#f4f4f4'
  disabled: '#eeeeee'
  hairline: '#e6e6e6'
  border: '#dddddd'
typography:
  detail-heading:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.33
    use: Section / product-detail headings (프립 정보), SUIT Bold
  product-title:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.6px'
    use: Product-detail H1 title, SUIT
  discount:
    fontSize: 24px
    fontWeight: 700
    use: Hero discount percentage in sale red
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading + UI text, SUIT
  cta:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Primary booking button label (참여하기), SUIT
  app-cta:
    fontSize: 12px
    fontWeight: 700
    use: App-download bar label (앱 다운로드), SUIT Bold
  badge:
    fontSize: 10px
    fontWeight: 500
    use: Corner tags (프립단독 / 슈퍼호스트), SUIT Medium
rounded:
  xs: 3px
  sm: 5px
  md: 10px
  lg: 12px
  pill: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 6
  md: 10
  base: 16
  lg: 20
  xl: 32
components:
  cta-primary:
    type: button
    backgroundColor: '#7a29fa'
    textColor: '#ffffff'
    rounded: 10px
    height: 56px
    padding: 16px
    typography: 16px / 400 SUIT
    use: Primary booking CTA (참여하기) on product pages
  cta-disabled:
    type: button
    backgroundColor: '#eeeeee'
    textColor: '#ffffff'
    rounded: 10px
    height: 56px
    padding: 16px
    typography: 16px / 400 SUIT
    use: Sold-out / disabled booking button (신청마감)
  app-download:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 0px
    typography: 12px / 700 SUIT
    use: App-download bar CTA (앱 다운로드)
  count-pill:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #dddddd'
    rounded: 20px
    padding: 7px 15px
    height: 36px
    typography: 14px / 400 SUIT
    use: Quantity / option selector pill on booking panel
  product-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 5px
    border: '1px solid #e6e6e6'
    use: Experience/product card — thumbnail + title, hairline outline, no shadow
  badge-exclusive:
    type: badge
    backgroundColor: '#f4373d'
    textColor: '#ffffff'
    rounded: 5px
    padding: 4px 6px
    typography: 10px / 500 SUIT
    use: 프립단독 (Frip-exclusive) corner tag
  badge-superhost:
    type: badge
    backgroundColor: '#7a29fa'
    textColor: '#ffffff'
    rounded: 5px
    padding: 4px 6px
    typography: 10px / 500 SUIT
    use: 슈퍼호스트 (Superhost) corner tag
  nav-tab:
    type: tab
    textColor: '#000000'
    typography: 14px / 400 SUIT
    active: 'text #7a29fa on active nav/category item'
    use: Top navigation / category tab
fonts:
  roles:
    display: SUIT
    body: SUIT
    fallback: UI Frip, Noto Sans KR
---

# Frip

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Frip; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/frip/DESIGN.md
