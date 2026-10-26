---
name: Danawa
colors:
  primary: '#2070eb'
  on-primary: '#ffffff'
  category: '#06b87f'
  ink: '#000000'
  ink-soft: '#0f0f0f'
  body: '#333333'
  muted: '#555555'
  muted-alt: '#767676'
  action-dark: '#333333'
  action-dark-hover: '#141414'
  white: '#ffffff'
  surface: '#f8f8f8'
  tint: '#ebf3ff'
  hairline: '#e0e0e0'
  border: '#bfbfbf'
  border-button: '#b9bec5'
typography:
  product-title:
    fontSize: 25px
    fontWeight: 700
    use: 'Product name at the top of the product page (h3.prod_tit), in #333333, line-height normal'
  section:
    fontSize: 21px
    fontWeight: 700
    lineHeight: 1.62
    use: 'Home section titles (h2.title), 34px line, in #0f0f0f; one 20px variant'
  tab:
    fontSize: 19px
    fontWeight: 700
    lineHeight: 2.37
    use: 'Product-page section tabs (h3.tab_txt), 45px line; selected #2070eb, others #333333'
  search:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.11
    use: 'Search field text on the list page and on home once focused, 20px line, in #0f0f0f'
  button-lg:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.31
    use: 전체 카테고리 button label on home, 21px line
  nav:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 2.27
    use: 'Home service navigation links, 34px line, in #333333; one bold #2070eb item'
  button:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 2.13
    use: 최저가 구매하기 and 대량구매 buttons on the product page, 32px line
  subsection:
    fontSize: 15px
    fontWeight: 700
    use: 'Product-page block headings (h4.tit), in #333333, line-height normal'
  pill:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 2.64
    use: Selected filter pill label, 37px line; unselected pills are 400
  badge:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Purchase badge on list and product-page ad cards, 18px line, white on #2070eb'
  body:
    fontSize: 12px
    fontWeight: 400
    use: Default body size on the list and product pages (home body is 16px), line-height normal
rounded:
  search: 52px
  pill: 19px
  tab: 8px
  card: 8px
  pager: 4px
  utility: 2px
spacing:
  badge-x: 6
  badge-y: 2
  category-x: 16
  category-y: 11
  search-left: 20
  button-x: 15
components:
  category-button:
    type: button
    backgroundColor: '#06b87f'
    textColor: '#ffffff'
    border: 'bottom 1px #31cb9a'
    rounded: 8px 8px 0px 0px
    padding: 11px 16px
    height: 44px
    typography: 16px / 700 / 21px Pretendard
    hover: label underline in white; fill unchanged
    pressed: label underline in white; fill unchanged
    focus: browser default outline only (rgb(0, 95, 204) auto 1px); no authored focus style
    states: 'probe on home: transition all 0s; hover and pressed underline the label; focus shows the default ring'
    use: 전체 카테고리 on the home header, the tab that opens the category tree
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#767676'
    rounded: 52px
    padding: 8px 0px 10px 20px
    height: 44px
    typography: 16px / 400 Pretendard
    hover: no change
    focus: 'text #0f0f0f at 18px, padding 10px 0px 10px 20px, wrapper shadow rgba(0, 0, 0, 0.08) 2px 2px 6px; the change persists after blur'
    states: 'probe on home: hover and pressed no change; focus restyles the field and its wrapper'
    use: Global search pill in the header of all three pages; the list page renders it in its focused style at rest
  filter-pill:
    type: button
    backgroundColor: '#ebf3ff'
    textColor: '#555555'
    rounded: 19px
    size: 220px x 38px
    typography: 14px / 400 / 37px Pretendard
    selected: 'bg #2070eb, fg #ffffff, 700'
    hover: label underline; fill unchanged
    pressed: label underline; fill unchanged
    states: 'probe on the product page: transition all 0s; focus not measured'
    use: Opinion filter pills (전체보기, 의견 ...) in the product-page community block
  buy-button:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 2px
    padding: 0px 15px
    height: 32px
    typography: 15px / 700 / 32px Pretendard
    hover: 'bg #141414'
    pressed: 'bg #141414'
    states: 'probe on the product page: transition all 0.3s ease-in-out, read after it settled; focus not measured'
    use: 최저가 구매하기, the product page's buy action
  b2b-button:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    border: '1px solid #c4c4c4'
    rounded: 2px
    padding: 0px 12px
    height: 32px
    typography: 15px / 700 / 32px Pretendard
    states: rest only; no state frame and not probed
    use: 대량구매 beside the buy action on the product page
  purchase-badge:
    type: badge
    backgroundColor: '#2070eb'
    textColor: '#ffffff'
    rounded: 0px 0px 8px
    padding: 2px 6px
    height: 22px
    typography: 12px / 700 / 18px Pretendard
    use: Purchase badge on the corner of ad product cards (ten instances on the list and product pages)
  product-tab:
    type: tab
    textColor: '#333333'
    height: 45px
    typography: 19px / 700 / 45px Pretendard
    selected: 'fg #2070eb'
    states: selected variant read from rest values of sibling tabs; hover and focus not measured
    use: Section tabs on the product page (가격비교, 상품정보 ...)
  clip-tab:
    type: tab
    backgroundColor: '#f8f8f8'
    textColor: '#333333'
    height: 37px
    typography: 14px / 400 Pretendard
    selected: 'bg #ffffff, fg #0f0f0f, 700'
    states: selected variant read from rest values of sibling tabs; hover and focus not measured
    use: Vertical shopping-clip tabs on home (h2.main-clip__tab)
  seller-buy-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #b9bec5'
    rounded: 0px
    size: 70px x 28px
    typography: 13px / 700 / 26px Pretendard
    states: rest on ten captured instances; no state frame and not probed
    use: Per-seller buy link in the price-comparison table (ten instances)
  detail-search-button:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 2px
    size: 90px x 28px
    typography: 12px / 400 / 28px Pretendard
    states: rest only; no state frame and not probed
    use: 상세 검색 in the list page's filter bar
  outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#2070eb'
    border: '1px solid #2070eb'
    rounded: 8px
    size: 400px x 68px
    typography: 20px / 700 Pretendard
    shadow: rgba(0, 0, 0, 0.2) 0px 2px 8px 0px
    states: rest only; no state frame and not probed
    use: Large outlined blue button low on the product page; its label was not recorded; the only shadowed element captured
  pager-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #e0e0e0'
    rounded: 4px 0px 0px 4px
    size: 20px x 20px
    states: rest on six captured pairs; no state frame and not probed
    use: Paired prev/next arrows on home carousels (the next arrow mirrors the radius)
  category-link:
    type: button
    backgroundColor: '#06b87f'
    textColor: '#ffffff'
    rounded: 2px
    size: 131px x 30px
    typography: 12px / 400 Pretendard
    hover: no change
    pressed: no change
    states: 'probe on the product page: no hover or pressed change; focus not measured'
    use: 전체 카테고리 link above the product-page breadcrumb
fonts:
  roles:
    body: Pretendard
---

# Danawa

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Danawa; reproduced for educational reference. Full prose: https://oh-my-design.kr/danawa/design.md
