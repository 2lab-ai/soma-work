---
name: Meituan
colors:
  brand: '#ffc300'
  brand-alt: '#ffd100'
  brand-pressed: '#f5b800'
  brand-tint: '#fff8e0'
  on-brand: '#222222'
  price: '#ff4b10'
  price-alt: '#ff5722'
  coupon: '#ff2d55'
  rating-gold: '#ffb000'
  page-ground: '#f5f5f5'
  card: '#ffffff'
  text-secondary: '#888888'
  text-hint: '#bbbbbb'
  border: '#eeeeee'
  divider: '#f2f2f2'
  success: '#52c41a'
  error: '#ff4d4f'
  warning: '#faad14'
typography:
  header:
    fontSize: 18px
    fontWeight: 600
    use: Section/page titles, merchant detail name
  merchant:
    fontSize: 16px
    fontWeight: 500
    use: Merchant name on card, one-line ellipsized
  price:
    fontSize: 18px
    fontWeight: 700
    use: Price, the loud number
  body:
    fontSize: 14px
    fontWeight: 400
    use: Body, category, deal description
  meta:
    fontSize: 13px
    fontWeight: 400
    use: Distance, delivery time, rating count
  badge:
    fontSize: 11px
    fontWeight: 500
    use: Deal tags, coupon chips
rounded:
  sm: 4px
  md: 8px
  lg: 20px
  full: 9999px
spacing:
  xs: 2
  sm: 6
  md: 8
  base: 10
  lg: 16
  xl: 20
  xxl: 32
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#ffc300'
    textColor: '#222222'
    rounded: 8px
    padding: 10px 20px
    typography: 15px/500
    use: Primary CTA Order/Pay, dark text on yellow
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    padding: 10px 20px
    typography: 15px/500
    use: Ghost/outline secondary action
  coupon-chip:
    type: badge
    backgroundColor: '#fff8e0'
    textColor: '#ff4b10'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/500
    use: Discount/coupon flag
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 20px
    padding: 8px 16px
    typography: 14px/400
    use: Top pill search bar
  merchant-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 10px
    use: Merchant feed card unit
  deal-tag:
    type: badge
    backgroundColor: '#ff4b10'
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 6px
    typography: 11px/500
    use: Deal/activity flag
fonts:
  roles:
    sans: PingFang SC
    mono: PingFang SC
---

# Meituan

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Meituan; reproduced for educational reference. Full prose: https://oh-my-design.kr/meituan/design.md
