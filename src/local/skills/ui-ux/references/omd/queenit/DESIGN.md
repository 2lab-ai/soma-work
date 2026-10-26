---
name: Queenit
colors:
  primary: '#642fe9'
  sale-purple: '#714fd8'
  accent-purple: '#603ec5'
  pink: '#e54d76'
  ink: '#000000'
  slate: '#292c31'
  muted: '#aaafbb'
  muted-alt: '#7d8597'
  canvas: '#ffffff'
  surface: '#edeef0'
  surface-alt: '#f2f3f5'
  hairline: '#e2e2e8'
  on-primary: '#ffffff'
  corp-ink: '#393838'
  corp-yellow: '#ffcb27'
typography:
  display:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.5
    use: Corporate section headlines (rapportlabs.kr), Pretendard Bold
  discount:
    fontSize: 16px
    fontWeight: 600
    use: Discount-rate percentage on product cards, Pretendard SemiBold
  body:
    fontSize: 16px
    fontWeight: 400
    use: Product UI text and category-nav labels, Pretendard
  promo:
    fontSize: 14px
    fontWeight: 600
    use: Promo overlay labels on banner images, Pretendard
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Corporate body copy, Noto Sans Korean
  input:
    fontSize: 14px
    fontWeight: 500
    use: Search input text, Pretendard
rounded:
  sm: 4px
  md: 6px
  base: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  section: 64
components:
  category-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 8px
    padding: 3.5px 11.5px
    height: 45px
    shadow: rgba(27,32,42,0.16) 0px 2px 6px -2px
    typography: 16px / 400 Pretendard
    use: Home shortcut chip (잘 사는 비결, 2만원 쿠폰, 매거진Q)
  floating-icon:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 50%
    padding: 8px
    height: 42px
    shadow: rgba(27,32,42,0.08) 0px 4px 8px -2px
    use: Floating circular quick-action icon button
  nav-tab:
    type: tab
    active: 'text #000000'
    textColor: '#aaafbb'
    typography: 16px / 400 Pretendard
    use: Top category nav (추천·라이프·뷰티·컨템퍼러리·남성)
  product-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 16px
    use: Product tile in the recommendation grid
  skeleton-block:
    type: card
    backgroundColor: '#edeef0'
    rounded: 16px
    use: Loading skeleton / image placeholder
  discount-badge:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#714fd8'
    rounded: 4px
    typography: 16px / 600 Pretendard
    use: Discount-rate percentage on product cards
  promo-pill:
    type: badge
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 8px
    typography: 14px / 600 Pretendard
    use: Promo overlay label on hero banner images
fonts:
  roles:
    product: Pretendard
    corp: Noto Sans Korean
---

# Queenit

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Queenit; reproduced for educational reference. Full prose: https://oh-my-design.kr/queenit/design.md
