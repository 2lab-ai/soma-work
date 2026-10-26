---
name: Hana Bank
colors:
  primary: '#008485'
  nav-hover: '#009591'
  canvas: '#ffffff'
  ink: '#000000'
  body: '#555555'
  body-home: '#666666'
  text-strong: '#333333'
  lnb-muted: '#637079'
  hairline: '#dddddd'
  surface: '#f3f3f3'
typography:
  hero:
    fontSize: 38px
    fontWeight: 800
    lineHeight: 1.26
    letterSpacing: '-0.5px'
    use: 'Home carousel headline (p), NotoSans_Bold, #000000'
  page-title:
    fontSize: 38px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-2px'
    use: 'Inner-page title (h3), NotoSans_Medium, #000000'
  section-title:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-3px'
    use: 'Left-navigation section title (h2), NotoSans_Medium, #008485 over a 3px #008485 rule'
  gnb:
    fontSize: 18px
    fontWeight: 400
    letterSpacing: '-0.5px'
    use: Main navigation tab label, NotoSans_Regular in a 70px line box
  lnb:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.88
    letterSpacing: '-1px'
    use: Left navigation link, NotoSans_Regular
  body:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Default body text
  news-title:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: '-0.5px'
    use: 'Home news headline (p), NotoSans_Medium, #333333'
rounded:
  control: 10px
  pill: 50px
  join: 20px
  small: 3px
spacing:
  gnb-x: 40
  lnb-top: 10
  lnb-right: 25
  lnb-bottom: 8
  footer-select-x: 16
  small-button-x: 13
  join-x: 20
components:
  gnb-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#000000'
    padding: 0px 40px
    height: 70px
    typography: 18px / 400 / 70px NotoSans_Regular, -0.5px tracking
    hover: 'fg #009591, NotoSans_Bold'
    states: 'hover and pressed both record #009591 text in NotoSans_Bold on all five tabs (captures 8-12) on each of the three pages; the two frames hold the same opaque value, so the transition had settled'
    use: Main banking navigation tab (a) at home::[data-omd-capture="8"], 112-150 x 70; the served HTML labels the five tabs 조회, 이체, 공과금, 외환, 금융상품
  lnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#637079'
    padding: 10px 25px 8px 0px
    size: 260px x 48px
    typography: 16px / 400 / 30px NotoSans_Regular, -1px tracking
    hover: 'fg #008485, NotoSans_Medium'
    states: 'hover and pressed record #008485 in NotoSans_Medium on seven sibling links on the product page (captures 17-23) and five on the news page (captures 16-20); the current item at rest (surface-2 capture 16, surface-3 capture 21) records the same #008485 NotoSans_Medium, but aria-current was not captured, so it is a described variant, not a selected state'
    use: Left navigation link at surface-2::[data-omd-capture="17"], 260 x 48
  slide-cta:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 50px
    size: 98px x 40px
    typography: 14px / 400 / 40px NotoSans_Regular, -0.5px tracking
    states: rest on six carousel slides (odd captures 19-29); the hover and pressed frames on captures 19, 21 and 23 recorded no change
    use: Home carousel action (a) at home::[data-omd-capture="19"]; the served HTML labels it 자세히보기
    height: 40px
    padding: 0px
    focus: text-decoration underline, browser default focus ring (outline auto) on :focus-visible
  footer-site-select:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#555555'
    border: '1px #dddddd'
    rounded: 10px 0px 0px 10px
    padding: 0px 16px
    size: 200px x 48px
    typography: 12px / 400 NotoSans_Regular
    states: 'rest only: these controls lie beyond the collector''s first 24 probed controls on each page, so no hover or pressed frame exists'
    use: Segmented footer site selector at home::[data-omd-capture="78"]; three joined buttons (first 10px 0px 0px 10px, middle 0px, last 0px 10px 10px 0px) share 1px 0px 1px 1px edges; identical on all three pages
  hanaworld-button:
    type: button
    backgroundColor: '#f3f3f3'
    textColor: '#000000'
    rounded: 10px
    size: 237px x 48px
    typography: 14px / 400 / 48px NotoSans_Regular, -0.5px tracking
    states: rest only (beyond the probed set)
    use: Footer grey button (button.btn--hanaworld) at home::[data-omd-capture="82"]; identical on all three pages
  product-join-pill:
    type: button
    backgroundColor: '#008485'
    border: '1px #16959c'
    rounded: 20px
    padding: 0px 20px
    size: 94px x 33px
    states: rest only (captures 41, 44, 47, beyond the probed set)
    use: 'Product-list join link (a.link-join) at surface-2::[data-omd-capture="41"]; the label colour is not claimed because the link computes #555555, which would sit on its own #008485 fill, and no separate label node was sampled'
  outline-small-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#555555'
    border: '1px #c1c1c1'
    rounded: 3px
    padding: 0px 13px
    height: 28px
    typography: 12px / 400 / 25px NotoSans_Regular
    states: rest only (captures 36-38, beyond the probed set)
    use: Small outline link button (a.btn) above the product list at surface-2::[data-omd-capture="36"], 68-121 wide
  teal-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#008485'
    border: '1px #a5d3d4'
    size: 146px x 38px
    typography: 14px / 700 / 38px; declared family 돋움, unresolved in the capture environment
    states: rest only (capture 32, beyond the probed set)
    use: Teal outline link (a.btnMiddle) on the news page at surface-3::[data-omd-capture="32"]
  news-search-input:
    type: input
    backgroundColor: transparent
    textColor: '#555555'
    border: '1px #dddddd'
    padding: 0px 0px 0px 10px
    size: 280px x 31px
    typography: 13.33px / 400 / 29px; declared family 돋움, unresolved in the capture environment
    states: rest only (capture 30, beyond the probed set); nothing was typed
    use: News search field (input.text) at surface-3::[data-omd-capture="30"]
  news-search-button:
    type: button
    backgroundColor: transparent
    textColor: '#028389'
    border: '1px #7cc2c2'
    size: 98px x 31px
    typography: 12px / 700 / 30px; declared family dotum, unresolved in the capture environment
    states: rest only (capture 31, beyond the probed set); never clicked
    use: News search button (button.searchBtn) at surface-3::[data-omd-capture="31"]
  pagination-item:
    type: button
    backgroundColor: transparent
    textColor: '#6e6e6e'
    border: '1px #ffffff'
    size: 27px x 27px
    typography: 14px / 700 / 27px; declared family 돋움, unresolved in the capture environment
    states: 'rest only (captures 43-56, beyond the probed set); the current page (a.on, capture 45) records #008486 text with a 1px #7fc0c2 border, a described variant'
    use: News-list pagination link at surface-3::[data-omd-capture="46"]
fonts:
  roles:
    ui: NotoSans_Regular
    medium: NotoSans_Medium
    bold: NotoSans_Bold
---

# Hana Bank

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Hana Bank; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/hana/DESIGN.md
