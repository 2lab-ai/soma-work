---
name: '591'
colors:
  primary: '#ff8000'
  canvas: '#ffffff'
  surface: '#f5f5f5'
  surface-blue: '#f2f8ff'
  surface-warm: '#fff7e6'
  ink: '#333333'
  body: '#4a4a4a'
  muted: '#666666'
  muted-light: '#999999'
  on-primary: '#ffffff'
  price-red: '#e60012'
  link: '#337ab7'
  border: '#e6e6e6'
  dark-overlay: '#262626'
typography:
  hero-title:
    fontSize: 50px
    fontWeight: 700
    use: App download section hero headline, orange accent
  nav-tab:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.31
    use: Primary navigation tab labels (租屋/中古屋/新建案)
  search-btn:
    fontSize: 20px
    fontWeight: 700
    use: Search CTA label in hero search bar
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body text, nav links, listing meta
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Listing page body, filter labels
  price:
    fontSize: 16px
    fontWeight: 700
    use: Rental price display in listing cards, red color
  caption:
    fontSize: 13px
    fontWeight: 400
    use: Small labels, tags, secondary metadata
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 48
components:
  button-search:
    type: button
    backgroundColor: '#ff8000'
    textColor: '#ffffff'
    rounded: 0px 2px 2px 0px
    height: 55px
    typography: 20px / 700
    use: Primary search CTA button on homepage hero
  button-search-rent:
    type: button
    backgroundColor: '#ff8000'
    textColor: '#ffffff'
    rounded: 0px 4px 4px 0px
    padding: 5px 16px
    height: 44px
    typography: 16px / 400
    use: Search button on rental listing page
  tab-active:
    type: tab
    backgroundColor: '#ff8000'
    textColor: '#ffffff'
    rounded: 2px
    padding: 0px 14px
    height: 30px
    typography: 16px / 700
    active: 'bg #ff8000 text #ffffff'
    use: Active property type tab (租屋/中古屋/新建案)
  tab-inactive:
    type: tab
    backgroundColor: transparent
    textColor: '#dddddd'
    rounded: 2px
    padding: 0px 14px
    height: 30px
    typography: 16px / 700
    use: Inactive navigation tab in hero search area
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 2px
    height: 55px
    border: 0px
    typography: 16px / 400
    use: Main property search input field on homepage
  input-filter:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 2px
    padding: 4px 12px
    height: 27px
    border: '1px solid #e6e6e6'
    typography: 13px / 400
    use: Filter range inputs (price, area, floor)
  card-listing:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    use: Rental listing item card, flat no-shadow, full-width row
  card-image:
    type: card
    backgroundColor: '#d8d8d8'
    textColor: '#000000'
    rounded: 8px 8px 0px 0px
    use: Listing photo container, top-rounded corners
  badge-tag:
    type: badge
    backgroundColor: '#fff7e6'
    textColor: '#ff8000'
    rounded: 2px
    typography: 13px / 400
    use: Feature tags and property type labels
  badge-price:
    type: badge
    backgroundColor: transparent
    textColor: '#e60012'
    rounded: 0px
    typography: 16px / 700
    use: Rental price display in listing cards
  nav-item:
    type: tab
    textColor: '#4a4a4a'
    typography: 14px / 400
    use: Main navigation items (首頁/新建案/中古屋/租屋)
    active: 'color #ff8000 on active page'
fonts:
  roles:
    display: Arial, 微軟正黑體, Microsoft JhengHei, sans-serif
    body: Arial, 微軟正黑體, Microsoft JhengHei, sans-serif
---

# 591

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 591; reproduced for educational reference. Full prose: https://oh-my-design.kr/591/design.md
