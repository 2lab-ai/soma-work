---
name: Bunjang
colors:
  primary: '#d80c18'
  brand: '#d80c18'
  canvas: '#ffffff'
  foreground: '#191919'
  muted: '#999999'
  on-primary: '#ffffff'
  surface: '#f6f6f6'
  hairline: '#e5e5e5'
  body: '#666666'
  error: '#d80c18'
  success: '#00a587'
  info: '#027aff'
  warning: '#ffc200'
  safe: '#5558a8'
  care: '#ffe1a6'
typography:
  section-title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.2
    use: Section title (오늘의 추천 아이템), gray-900
  subsection:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.2
    use: Subsection title / large emphasis, gray-900
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.2
    use: Default body, CTA label, gray-900 / white-on-red
  price:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.2
    use: Price — the headline, gray-900
  search-input:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 18
    use: Search input value + placeholder, gray-900
  card-title:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    use: 'Product card title, gray-600 #666'
  chip-emphasis:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.2
    use: Compact emphasized chip
  meta:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.2
    use: 'Meta / timestamp / region, gray-300 #999'
rounded:
  sm: 4px
  md: 6px
  lg: 20px
  full: 999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#d80c18'
    textColor: '#ffffff'
    border: none
    rounded: 6px
    padding: 16px 20px
    typography: 16px / 400
    use: Single highest-intent CTA per surface — the only place red appears
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#4c4c4c'
    border: '1px solid #e5e5e5'
    rounded: 6px
    padding: 12px 20px
    typography: 16px / 400
    use: Secondary action
  input-search:
    type: input
    backgroundColor: transparent
    textColor: '#191919'
    rounded: 999px
    typography: 15px / 500
    use: Search input; rounded pill container carries chrome, placeholder 검색
  product-card:
    type: card
    backgroundColor: '#f6f6f6'
    rounded: 6px
    use: '81:100 portrait thumb placeholder; price 16/700 #191919, title 14/500 #666, meta 12/500 #999, heart top-right'
  chip-safe:
    type: badge
    backgroundColor: '#5558a8'
    textColor: '#ffffff'
    rounded: 6px
    typography: 13px / 700
    use: 안전결제 escrow chip — indigo --color-safe ladder
  chip-care:
    type: badge
    backgroundColor: '#ffe1a6'
    textColor: '#191919'
    rounded: 6px
    typography: 13px / 700
    use: 감정완료 luxury-auth chip — warm amber --color-care ladder
  chip-info:
    type: badge
    backgroundColor: '#027aff'
    textColor: '#ffffff'
    rounded: 6px
    typography: 13px / 700
    use: 내폰시세 price-verified chip — info blue
  heart-button:
    type: toggle
    textColor: '#ffffff'
    shadow: 10% black inner-fill glow under SVG
    active: 'solid #d80c18 fill'
    use: 찜 heart button, white stroke legible on any thumbnail
fonts:
  roles:
    sans: Pretendard Variable
    mono: sans-serif
---

# Bunjang

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bunjang; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/bunjang/DESIGN.md
