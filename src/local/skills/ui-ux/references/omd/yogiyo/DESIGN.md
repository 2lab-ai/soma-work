---
name: Yogiyo
colors:
  primary: '#fa0050'
  primary-deep: '#e00048'
  canvas: '#ffffff'
  surface: '#f5f5f7'
  surface-strong: '#ececef'
  heading: '#1a1a1a'
  text-strong: '#333333'
  body: '#666666'
  text-secondary: '#999999'
  text-tertiary: '#bbbbbb'
  border: '#dddddd'
  divider: '#ececef'
  rating: '#ffb300'
  success: '#21c17a'
  warning: '#ff8a00'
  error: '#f5444c'
  on-primary: '#ffffff'
typography:
  hero:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.3
    use: Event/promo banners, onboarding
  section:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.35
    use: Row headers
  restaurant:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Restaurant card title
  menu:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.4
    use: Menu item title
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Descriptions, address
  label:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Button labels (주문하기)
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Delivery time, review count, fine print
  price:
    fontSize: 19px
    fontWeight: 700
    lineHeight: 1.2
    use: Item/cart total — tabular numerals
rounded:
  sm: 6px
  md: 12px
  lg: 16px
  full: 999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#fa0050'
    textColor: '#ffffff'
    rounded: 12px
    padding: 14px 20px
    typography: 16/600
    use: 주문하기, 결제하기 — full-width sticky CTA
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#fa0050'
    rounded: 12px
    padding: 14px 20px
    typography: 16/600
    use: 쿠폰 받기, 메뉴 더보기
  button-neutral:
    type: button
    backgroundColor: '#f5f5f7'
    textColor: '#333333'
    rounded: 12px
    padding: 14px 20px
    typography: 16/600
    use: 취소, 닫기
  search-field:
    type: input
    backgroundColor: '#f5f5f7'
    textColor: '#333333'
    rounded: 12px
    padding: 14px 16px
    typography: 16/400
    use: 음식, 가게 검색
  restaurant-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 16px
    use: Browse workhorse — photo, name, rating, ETA
  category-tile:
    type: card
    backgroundColor: '#f5f5f7'
    rounded: 12px
    padding: 12px
    use: 치킨/피자/한식 grid tiles
  discount-badge:
    type: badge
    backgroundColor: '#fa0050'
    textColor: '#ffffff'
    rounded: 6px
    padding: 2px 6px
    typography: 11/700
    use: 할인/쿠폰 promotion flag
  filter-chip:
    type: badge
    backgroundColor: '#f5f5f7'
    textColor: '#666666'
    rounded: 999px
    padding: 6px 14px
    typography: 13/500
    use: 빠른배달/무료배달/별점순 filters
  top-tab:
    type: tab
    textColor: '#999999'
    typography: 15/600
    active: '#fa0050 text + 2px bottom underline #fa0050'
    use: 배달/포장/요편의점 switcher
  bottom-tab:
    type: tab
    textColor: '#bbbbbb'
    typography: 11/500
    active: '#fa0050 icon + label'
    use: 홈/검색/찜/주문내역/MY
  snackbar:
    type: toast
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 12px
    padding: 12px 16px
    typography: 14/500
    use: Transient feedback, 3s auto-dismiss
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# Yogiyo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Yogiyo; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/yogiyo/DESIGN.md
