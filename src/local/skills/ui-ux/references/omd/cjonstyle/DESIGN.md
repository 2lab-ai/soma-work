---
name: CJ ONSTYLE
colors:
  primary: '#640faf'
  on-primary: '#ffffff'
  ink: '#000000'
  ink-strong: '#111111'
  tab-ink: '#333333'
  muted: '#767676'
  faint: '#929292'
  chrome: '#26292a'
  border-strong: '#b2b2b2'
  line: '#d1d1d1'
  line-soft: '#e6e6e6'
  control-line: '#c5c5c5'
  select-line: '#d9d9d9'
  surface: '#f0f0f0'
  white: '#ffffff'
typography:
  module-title:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.19
    letterSpacing: '-0.5px'
    use: 'Module titles on the home tab (tit_module), Pretendard, 31px line, in #111111'
  logo-heading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.5px'
    use: 'The h1 around the logo on every captured page, 36px line, in #000000; set in the declared 나눔바른고딕 stack, whose rendered face is unresolved'
  buy-label:
    fontSize: 20px
    fontWeight: 400
    use: 바로구매, 장바구니 and 선물하기 labels on the product page, set in the 나눔바른고딕 stack on a 60px line box
  tab:
    fontSize: 18px
    fontWeight: 700
    use: Selected product-page section tab; unselected tabs are 18px / 400
  search:
    fontSize: 18px
    fontWeight: 400
    use: Header search field; Pretendard on the home tab, the 나눔바른고딕 stack on the product and brand pages
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.25px'
    use: 'Module lists and product text on the home tab, Pretendard, 24px line, in #000000'
  chip:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.2
    use: Selected module filter chip on the home tab, Pretendard, 18px line; unselected chips are 15px / 400
  more:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.23
    letterSpacing: '-0.25px'
    use: Module 'more' links on the home tab, Pretendard, 16px line
  meta:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Product meta on the brand and product pages, 18px line, in #000000, in the 나눔바른고딕 stack'
  fine:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.5px'
    use: 'Fine labels on the product page, 16.5px line, in #929292, in a 돋움 stack whose rendered face is unresolved'
rounded:
  square: 0px
  tag: 2px
  button: 4px
  more: 14px
  chip: 18px
spacing:
  ask-y: 22
  ask-left: 72
  select-left: 15
  skip-left: 26
  skip-right: 20
  more-left: 12
  more-right: 8
components:
  buy-button:
    type: button
    backgroundColor: '#640faf'
    textColor: '#ffffff'
    border: '1px solid #640faf'
    rounded: 4px
    height: 60px
    typography: 20px / 400, 나눔바른고딕 stack
    states: rest only; no state frame was captured for this control and it was not probed
    use: 바로구매 (u_btn btn_buy_now) on the product page, 162 x 60 at the right of the buy row; a 205 x 42 copy closes the lower buy panel
  cart-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#640faf'
    border: '1px solid #640faf'
    rounded: 4px
    height: 60px
    typography: 20px / 400, 나눔바른고딕 stack
    states: rest only; no state frame
    use: 장바구니 (btn_cart_go), the outlined partner left of 바로구매; 선물하기 (btn_gift, 64 x 60) uses the same outline
  wish-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111111'
    border: '1px solid #b2b2b2'
    rounded: 4px
    size: 64px x 60px
    states: rest only; no state frame
    use: 찜 wishlist toggle (btn_dip) at the start of the buy row
  category-toggle:
    type: button
    textColor: '#111111'
    height: 54px
    typography: 15px / 400, 나눔바른고딕 stack
    hover: 'bg #640faf, fg #ffffff'
    pressed: 'bg #640faf, fg #ffffff'
    states: the bundle's hover and pressed frames agree on the violet fill with white text
    use: 카테고리 toggle (btn_gnb_toggle), 181 x 54, at the left of the global navigation
  detail-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#767676'
    border: '0 0 1px #767676 (bottom)'
    height: 62px
    typography: 18px / 400, 나눔바른고딕 stack
    selected: 'fg #333333, 18px / 700, bottom border 1px #333333'
    states: selected variant read from rest values
    use: Product-page section tabs, 253 x 62
  module-chip:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#111111'
    border: '1px solid #e6e6e6'
    rounded: 18px
    height: 36px
    typography: 15px / 400 Pretendard
    selected: 'bg #111111, fg #ffffff, border 1px #111111, 15px / 700'
    states: selected variant read from rest values
    use: Filter chips (btn_tab) under home module titles
  more-chip:
    type: button
    textColor: '#111111'
    border: '1px solid #d1d1d1'
    rounded: 14px
    padding: 0px 8px 0px 12px
    height: 28px
    typography: 13px / 400 Pretendard
    states: rest only; the home tab's pseudo-state pass stalled and was logged unmeasured
    use: '''More'' links beside home module titles, 99 x 28'
  carousel-control:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #d1d1d1'
    rounded: 18px 0 0 18px (previous), 0 18px 18px 0 (next), 50% (pause)
    height: 36px
    states: rest only; hover unmeasured
    use: Previous, next and pause controls of the home hero carousel
  option-select:
    type: input
    textColor: '#111111'
    border: '1px solid #d9d9d9'
    padding: 0px 33px 0px 15px
    height: 45px
    typography: 15px / 400, 나눔바른고딕 stack
    states: rest only; the collector did not open it
    use: Product option selector (select_txt), 470 x 45
  search-input:
    type: input
    textColor: '#111111'
    padding: 0px 50px 0px 0px
    height: 46px
    typography: 18px / 400 Pretendard (home)
    states: rest only; the input itself draws no border
    use: Header search field, 314 x 46, on every captured page
  ask-banner:
    type: button
    backgroundColor: '#f0f0f0'
    textColor: '#000000'
    rounded: 2px
    padding: 22px 50px 22px 72px
    size: 760px x 80px
    typography: 12px / 400 / 18px
    states: rest only; no state frame
    use: Product-page entry banner (btn_ask) with a 34-character label
  view-toggle:
    type: toggle
    border: '1px solid #d9d9d9'
    size: 30px x 30px
    checked: 'border 1px solid #640faf on the active view (ico_gallery on)'
    states: checked variant read from rest values
    use: Gallery and list view switch on the brand page
  page-dot:
    type: button
    backgroundColor: '#640faf'
    textColor: '#ffffff'
    rounded: 50%
    size: 30px x 30px
    states: the current page (lk_pn on) fills violet; read from rest values
    use: Current page of the brand page's pagination
  refresh-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111111'
    border: '1px solid #c5c5c5'
    rounded: 4px
    height: 40px
    typography: 14px / 400, 나눔바른고딕 stack
    states: rest only; no state frame
    use: Filter reset (btn_refresh) on the brand page, 180 x 40
  skip-link:
    type: button
    backgroundColor: '#26292a'
    textColor: '#ffffff'
    padding: 0px 20px 0px 26px
    height: 34px
    typography: 11px / 400 / 14px, letter-spacing -1px
    states: positioned 34px above the viewport at rest (shown when focused); focus was not measured
    use: Skip links (shortcut_g) at the top of every captured page
fonts:
  roles:
    ui: Pretendard
---

# CJ ONSTYLE

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to CJ ONSTYLE; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/cjonstyle/DESIGN.md
