---
name: Fitpet
colors:
  primary: '#0050ff'
  primary-deep: '#0035a8'
  brand-blue-lt: '#1482ff'
  accent-orange: '#ff9300'
  sale: '#ff5967'
  points: '#ffd633'
  ink: '#1b1e21'
  ink-corp: '#282828'
  body: '#42494f'
  muted: '#727a82'
  muted-alt: '#8c949c'
  faint: '#a7aeb5'
  canvas: '#ffffff'
  surface: '#f4f7fa'
  promo-tint: '#edf4ff'
  hairline: '#eef1f5'
  border: '#dfe3e8'
  border-strong: '#c2c8cf'
  on-dark: '#eeeeee'
  ink-pure: '#000000'
typography:
  stat-hero:
    fontSize: 85px
    fontWeight: 600
    use: Big number stat on corporate hero (16만+), Noto Sans KR
  display:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.2
    use: Corporate hero headline, Noto Sans KR
  section:
    fontSize: 24px
    fontWeight: 700
    use: Mall section title (오늘의 핫딜), Pretendard
  subsection:
    fontSize: 19px
    fontWeight: 700
    use: Mall page / group title (홈), Pretendard
  product:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.4
    use: Product-card title, Pretendard
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body copy, search field text
  nav:
    fontSize: 13px
    fontWeight: 700
    use: Corporate nav link, Poppins
  caption:
    fontSize: 12px
    fontWeight: 400
    use: Badges, metadata, fine print, Pretendard
rounded:
  sm: 5px
  md: 10px
  chip: 30px
  pill: 999px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  base: 15
  md: 16
  lg: 24
  chip: 30
  xl: 39
  xxl: 50
components:
  button-primary:
    type: button
    backgroundColor: '#0050ff'
    textColor: '#ffffff'
    rounded: 28px
    padding: 7px 17px
    height: 48px
    typography: 13px / 400 Pretendard
    use: Primary / recommend action button on the mall
  button-ghost:
    type: button
    textColor: '#ffffff'
    border: '2px solid #ffffff'
    rounded: 30px
    padding: 10px 50px
    height: 42px
    typography: 12px / 600 Poppins
    use: Ghost pill CTA over corporate hero imagery (일반채용)
  search-input:
    type: input
    backgroundColor: '#f4f7fa'
    textColor: '#000000'
    rounded: 10px
    padding: 1px 50px
    height: 50px
    typography: 16px Pretendard
    use: 'Filled borderless search field, placeholder #a7aeb5'
  filter-chip:
    type: badge
    textColor: '#42494f'
    border: '1px solid #c2c8cf'
    rounded: 999px
    padding: 0 14px
    height: 43px
    typography: 13px / 400 Pretendard
    use: Category / filter chip on the mall
  discount-badge:
    type: badge
    backgroundColor: '#ff5967'
    textColor: '#ffffff'
    rounded: 5px
    padding: 5px
    typography: 12px / 700 Pretendard
    use: Discount-percentage badge on product cards
  product-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #eef1f5'
    rounded: 10px
    use: 'Product card on grey #f4f7fa surface, hairline separation, near-flat'
  promo-strip:
    type: card
    backgroundColor: '#edf4ff'
    textColor: '#42494f'
    rounded: 10px
    use: First-purchase / coupon promo strip
  nav-link:
    type: tab
    textColor: '#000000'
    typography: 13px / 700 Poppins
    active: 'text #1482ff'
    use: Corporate top-nav item (회사 소개, 팀 문화)
fonts:
  roles:
    display: Poppins
    kr: Noto Sans KR
    product: Pretendard
---

# Fitpet

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Fitpet; reproduced for educational reference. Full prose: https://oh-my-design.kr/fitpet/design.md
