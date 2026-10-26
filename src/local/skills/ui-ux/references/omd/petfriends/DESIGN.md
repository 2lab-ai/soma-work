---
name: Pet Friends
colors:
  primary: '#ff4081'
  on-primary: '#ffffff'
  ink: '#2d3035'
  ink-pure: '#000000'
  muted: '#9ca1aa'
  discount: '#f33f46'
  magenta: '#ea306f'
  surface-pink: '#fff1f5'
  hairline: '#e9ebec'
typography:
  section-title:
    fontSize: 18px
    fontWeight: 700
    letterSpacing: '-0.2px'
    use: 'Merchandising section headings on home (h2, line height normal), in #2d3035; the emphasised phrase inside each heading is set apart in pink (see §3)'
  list-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.2px'
    use: Page title in the header of the best-products list, 20px line
  search:
    fontSize: 20px
    fontWeight: 500
    use: Search field text and placeholder (어떤 상품을 찾으시나요?)
  keyword:
    fontSize: 16px
    fontWeight: 500
    letterSpacing: '-0.2px'
    use: 'Trending-keyword pill labels (체험단, 개구리, 오리젠), in #2d3035'
  tab-selected:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 2.14
    use: 'Selected category tab label (사료), white on #ff4081, 30px line'
  tab:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 2.14
    use: 'Unselected category tab labels (간식, 용품), in #2d3035, 30px line'
  nav-selected:
    fontSize: 14px
    fontWeight: 700
    letterSpacing: '-0.2px'
    use: Label of the current top tab (HOME), line height normal
  nav:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.64
    letterSpacing: '-0.2px'
    use: 'Top tab labels (웰컴펫페어, 심쿵펫페어, 사료 최저가 도전!), 23px line, in #2d3035'
  product-title:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: '-0.2px'
    use: 'Product names in home carousels, 18px line, in #2d3035'
  product-title-list:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.64
    letterSpacing: '-0.2px'
    use: Product names in the best-products grid, 23px line
  meta:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: '-0.2px'
    use: Sub-category names under the category tabs (어덜트, 퍼피, 시니어) and small product lines, 12px line
  label-bold:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.2px'
    use: '펫프 Only label above exclusive products, in #ea306f'
  hint:
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.2px'
    use: 'Age hints under sub-categories ((1-7세), (1세미만)), in #9ca1aa'
rounded:
  input: 6px
  tile: 8px
  tab: 16px
  pill: 18.5px
  chip: 36px
  cta: 48px
  sort: 100px
spacing:
  chip-y: 4
  chip-x-start: 12
  chip-x-end: 8
  chip-gap: 8
  pill-y: 3
  pill-x: 15
  input-y: 14.5
  input-x: 16
  input-icon: 44
  nav-top: 14
  nav-bottom: 10
  gutter: 16
  sort-x: 12
components:
  category-tab:
    type: tab
    textColor: '#2d3035'
    rounded: 16px
    size: 74px x 32px
    typography: 14px / 500 / 30px Lific
    selected: 'bg #ff4081, fg #ffffff, 14px / 700 (class data-[state=active]:bg-brand)'
    states: selected read from rest values; hover and pressed unmeasured because the page ignored the pointer while the app-install sheet was open, and Tab never reached the tabs; transition all 0s
    use: 사료 / 간식 / 용품 category switcher on home at home::[data-omd-capture="49"] (selected) and [data-omd-capture="50"]
  app-install-button:
    type: button
    backgroundColor: '#ff4081'
    textColor: '#ffffff'
    rounded: 48px
    height: 48px
    size: 162px x 48px
    typography: 16px / 700 Lific (label p) with a white download icon
    states: 'probe: hover and pressed show no change across the button, its 5 descendants and 3 ancestor levels (transition all 0s); focus was not reached by the Tab walk'
    use: APP 설치하기 in the app-install sheet that opens over home for logged-out visitors (펫프렌즈 앱에서 가입하면 5,000원 쿠폰 즉시 지급); read by the fixed probe
  header-chip:
    type: button
    backgroundColor: '#fff1f5'
    textColor: '#2d3035'
    rounded: 36px
    padding: 4px 8px 4px 12px
    height: 32px
    typography: 14px / 700 Lific (label span)
    states: 'probe: focus (Tab #24) shows no change; hover and pressed unmeasured (pointer ignored while the sheet was open)'
    use: 'Pet-type (강아지) and delivery-address (배송지 입력) selectors in the app header, each with a chevron icon; the button itself computes #000000, the visible label is its child span'
  keyword-pill:
    type: badge
    backgroundColor: rgba(255, 170, 199, 0.5)
    textColor: '#2d3035'
    rounded: 18.5px
    padding: 3px 15px
    height: 30px
    typography: 16px / 500 Lific, letter-spacing -0.2px (label p)
    states: 'probe: focus (Tab #12) shows no change; hover and pressed unmeasured'
    use: 'Trending search keywords (체험단, 개구리, 오리젠, 호랑이, 터키츄) under the search field of the desktop side panel, linking to search results; the anchor computes #ffffff but the visible label is its child p'
  search-input:
    type: input
    textColor: '#2d3035'
    border: none
    rounded: 6px
    padding: 14.5px 44px 14.5px 16px
    height: 52px
    typography: 20px / 500 Lific
    states: 'probe: focus (Tab #10) shows no change on the field or its three ancestors; hover and pressed unmeasured'
    use: Product search in the desktop side panel, placeholder 어떤 상품을 찾으시나요?, 280 x 52; the frame drawn around it and the round submit control are painted by something outside the probe's compared scope, so no frame colour is declared
  sort-button:
    type: button
    border: '1px solid #e9ebec'
    rounded: 100px
    padding: 0px 12px
    height: 32px
    states: rest only; no state frame was recorded and the probe did not read it
    use: 펫프추천순 sort control at the top of the best-products list at surface-2::[data-omd-capture="15"], 105 x 32; its label sits in a child span the collector did not record, so no label colour is declared
  nav-tab:
    type: tab
    textColor: '#2d3035'
    padding: 14px 0px 10px
    height: 47px
    typography: 14px / 400 / 23px Lific, letter-spacing -0.2px (label p)
    selected: label 14px / 700 on the current tab (HOME); the underline indicator was not recorded
    states: selected variant read from rest values; no pointer or focus state was read
    use: Scrolling top tabs of the app (HOME, 웰컴펫페어, 심쿵펫페어, 사료 최저가 도전!, 할인, NEW 신상, 오직 펫프에서만) in a role=tablist nav
  banner-control:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.1)
    rounded: 8px
    padding: 7px
    size: 30px x 30px
    states: rest only; not probed
    use: Icon control over the home banner carousel, with a 4px backdrop blur (class backdrop-blur-[4px])
  image-tile:
    type: card
    rounded: 8px
    size: 136px x 72px
    use: Rounded image tiles on home (4 instances)
fonts:
  roles:
    brand: Lific
---

# Pet Friends

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Pet Friends; reproduced for educational reference. Full prose: https://oh-my-design.kr/petfriends/design.md
