---
name: Kyobo Book Centre
colors:
  primary: '#5055b1'
  primary-hover: '#2c307c'
  on-primary: '#ffffff'
  secondary: '#767676'
  secondary-hover: '#595959'
  secondary-pressed: '#292929'
  ink: '#000000'
  body: '#595959'
  muted: '#767676'
  accent: '#474c98'
  promo-green: '#2a760c'
  promo-green-dark: '#195800'
  hairline: '#eaeaea'
  border: '#d5d5d5'
  border-strong: '#cccccc'
  surface: '#f2f2f2'
  white: '#ffffff'
typography:
  page-title:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.375
    letterSpacing: '-0.32px'
    use: Store page heading (h4) on the weekly bestseller, Pretendard, 44px line; the same 32px / 44px pair as KDS h1 $font-title-xl
  title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.42
    letterSpacing: '-0.24px'
    use: 'Home section headings (h2, Roboto with NotoSansKR) and the store h1, 34px line, in #000000'
  error-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.56
    letterSpacing: '-0.18px'
    use: Heading of the product route's error view, Pretendard (served as PretendardNoPreload), 28px line
  nav-promo:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.16px'
    use: Green promotional links in the header navigation, 24px line
  button-lg:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.16px'
    use: Large 50px actions (홈으로 가기, 이전페이지) on the product route's error view, 24px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.16px'
    use: 'Document default on all three routes, 24px line, in #000000'
  tab:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.16px'
    use: 'Store category tabs, 24px line, in #767676; the selected tab is #000000 at weight 500'
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: '-0.14px'
    use: 'Book introductions in bestseller rows, 22px line, in #595959'
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.57
    letterSpacing: '-0.14px'
    use: 바로구매, 장바구니 and toolbar button labels, Pretendard, 22px line
  label:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '-0.12px'
    use: 'Blue-800 labels on home, 18px line, in #474c98'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.12px'
    use: 'Footer company details and top-bar utility links, 18px line, in #767676 or #595959'
  fine:
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.1px'
    use: 'Footer notes, 14px line, in #767676'
rounded:
  tag: 4px
  button: 8px
  cover: 16px
  search: 24px
  pill: 9999px
spacing:
  button-y: 9
  button-x: 14
  field-y: 13
  field-x: 16
  toggle-pad: 11
  row-top: 36
components:
  buy-now-button:
    type: button
    backgroundColor: '#5055b1'
    textColor: '#ffffff'
    rounded: 8px
    padding: 9px 14px
    height: 38px
    typography: 14px / 500 / 22px Pretendard, letter-spacing -0.14px
    hover: 'bg #2c307c'
    pressed: 'bg #2c307c'
    states: 'probe on the weekly bestseller: hover and pressed settle on #2c307c after a 0.2s colour transition; focus was not measured (the probe ran with --no-focus) and the collector''s pseudo-state pass stalled, so no focus style is declared'
    use: 바로구매 in every row of the weekly bestseller at surface-2::[data-omd-capture="69"], 100 x 38; the one filled indigo action per row, under 장바구니
  cart-button:
    type: button
    backgroundColor: '#767676'
    textColor: '#ffffff'
    rounded: 8px
    padding: 9px 14px
    height: 38px
    typography: 14px / 500 / 22px Pretendard, letter-spacing -0.14px
    hover: 'bg #595959'
    pressed: 'bg #292929'
    states: 'probe: hover #595959, pressed #292929 (0.2s colour transition); focus not measured'
    use: 장바구니 above 바로구매 in each bestseller row at surface-2::[data-omd-capture="68"], 100 x 38
  outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 8px
    padding: 9px 14px
    height: 38px
    typography: 14px / 500 / 22px Pretendard, letter-spacing -0.14px
    hover: 'bg #f2f2f2'
    pressed: 'bg #f2f2f2'
    states: 'probe on 상세보기 and the 찜하기 icon button: hover and pressed fill #f2f2f2; focus not measured'
    use: Toolbar actions over the bestseller list (장바구니 at surface-2::[data-omd-capture="61"], 엑셀로 받기) and 상세보기 in rows, 38px tall; the 38 x 38 찜하기 icon button uses the same border with 9px padding
  view-toggle:
    type: toggle
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 4px 0px 0px 4px and 0px 4px 4px 0px (segmented pair)
    padding: 11px
    height: 38px
    hover: 'bg #f2f2f2'
    pressed: 'bg #f2f2f2'
    states: 'probe on 리스트형 보기: hover and pressed #f2f2f2; the rest values of the two halves do not show which view is selected, so no selected style is declared'
    use: List and thumbnail view pair at surface-2::[data-omd-capture="58"] and [59], 39 x 38 and 40 x 38
  error-primary-button:
    type: button
    backgroundColor: '#5055b1'
    textColor: '#ffffff'
    rounded: 8px
    height: 50px
    typography: 16px / 700 / 24px Pretendard (PretendardNoPreload), letter-spacing -0.16px
    states: rest only; not probed
    use: 이전페이지 on the error view the product route rendered, at surface-3::[data-omd-capture="32"], 125 x 50
    padding: 0px
    pressed: 'bg #2c307c (:hover + :active)'
  error-outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#5055b1'
    border: '1px solid #5055b1'
    rounded: 8px
    height: 50px
    typography: 16px / 700 / 24px Pretendard (PretendardNoPreload), letter-spacing -0.16px
    states: rest only; not probed
    use: 홈으로 가기 beside 이전페이지 at surface-3::[data-omd-capture="31"], 125 x 50
  category-tab:
    type: tab
    textColor: '#767676'
    padding: 0px 14px
    height: 42px
    typography: 16px / 400 / 24px Pretendard, letter-spacing -0.16px
    selected: 'fg #000000 at weight 500, 43px tall'
    states: selected variant read from rest values; no pointer frame
    use: Category tabs of the weekly bestseller, 140px wide, at surface-2::[data-omd-capture="52"]; the selected tab is capture 51
  rail-tab:
    type: tab
    textColor: '#595959'
    typography: 14px / 400 / 22px Roboto with NotoSansKR
    selected: 'fg #474c98 at weight 700'
    states: selected variant read from rest values; no pointer frame
    use: Filter buttons over a home rail at home::[data-omd-capture="64"]; the selected one is capture 69
  search-field:
    type: input
    textColor: '#000000'
    rounded: 24px 0px 0px 24px (scope button)
    padding: 13px 16px (input)
    height: 48px (scope button); 42px input
    typography: 14px / 400 / 22px, letter-spacing -0.14px
    states: rest only; the collector pseudo-state pass stalled and the field was not probed, so no focus or hover value is declared
    use: 'Header integrated search: a 116 x 48 scope button with a 24px 0 0 24px radius (home::[data-omd-capture="16"]) leading a 395 x 42 search input (capture 17), on all three routes'
  menu-button:
    type: button
    backgroundColor: transparent
    border: '1px solid #d5d5d5'
    rounded: 9999px
    size: 44px x 44px
    states: rest only; not probed
    use: Round 전체메뉴열기 button in the header at home::[data-omd-capture="21"], on all three routes
  recent-button:
    type: button
    backgroundColor: '#f2f2f2'
    rounded: 9999px
    size: 50px x 50px
    states: rest only; not probed
    use: Round counter button (class recent-ctt-modal) in the floating side bar at surface-2::[data-omd-capture="223"]
  footer-select:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #d5d5d5'
    rounded: 8px
    padding: 8px 14px
    height: 40px
    typography: 14px / 400 / 22px, letter-spacing -0.14px
    states: rest only; not probed
    use: Family Site and SNS 바로가기 selectors in the footer at surface-2::[data-omd-capture="219"], 200 x 40, on all three routes
  footer-tag:
    type: badge
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 4px
    height: 24px
    typography: 12px / 400 / 18px, letter-spacing -0.12px
    use: '서비스가입확인 link in the footer at surface-2::[data-omd-capture="221"]; 사업자정보확인 beside it takes a #d5d5d5 border and #595959 label'
  cover-link:
    type: card
    border: '1px solid #eaeaea'
    rounded: 16px 16px 16px 0px, or square
    use: Book-cover links in home rails at home::[data-omd-capture="95"]; 46 captured covers take the asymmetric 16px 16px 16px 0px shape, the rest are square
  list-row:
    type: listItem
    border: '1px solid #eaeaea (top)'
    padding: 36px 0px 0px
    use: Weekly bestseller rows at surface-2::li, 984px wide, separated by a top hairline
fonts:
  roles:
    commerce: Pretendard
    portal: Roboto, NotoSansKR
---

# Kyobo Book Centre

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kyobo Book Centre; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kyobobook/DESIGN.md
