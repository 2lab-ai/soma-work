---
name: 롯데ON
colors:
  primary: '#000000'
  foreground: '#333333'
  canvas: '#ffffff'
  muted: '#757575'
  secondary: '#666666'
  hairline: '#e5e5e5'
  field-border: '#dddddd'
  tab-border: '#eeeeee'
typography:
  home-heading:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.27
    use: Observed home body-heading text
  body:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.29
    use: Observed home commerce body text
  tab-label:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.31
    use: Home image-tab label
rounded:
  square: 0px
  pill: 23px
spacing:
  xs: 2
  sm: 4
  md: 8
  base: 16
components:
  product-card:
    type: card
    backgroundColor: transparent
    rounded: 0px
    padding: 0px
    height: 368px
    use: Repeated home product-card container; its name, price and tags sit in child elements, so no label colour or font is declared (corrected 2026-09-30)
  home-image-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#666666'
    border: '1px solid #eeeeee'
    rounded: 23px
    padding: 0px 16px 0px 4px
    height: 46px
    typography: 16px / 500
    selected: 'bg #000000, fg #ffffff, border 1px #000000'
    states: default and selected captured (aria-selected true on capture 147 and on three tab-interaction captures); hover, focus, pressed, disabled and error were not sampled
    use: Home image-tab control
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px 28px 0px 0px
    height: 30px
    typography: 16px / 400
    states: default captured; hover, focus, pressed, disabled and error were not sampled
    use: Home search field
  recent-products-dropdown:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #dddddd'
    rounded: 0px
    padding: 0px 38px 0px 16px
    height: 32px
    typography: 13px / 400
    states: default captured; hover, focus, pressed, disabled and error were not sampled
    use: Dropdown trigger in the recent-products page footer row (captures 89 and 90 at top 1690, below the content area that ends at 1675); corrected 2026-09-30 from a recently viewed products trigger
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: 'outline #333333 solid 3px on :focus-visible'
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px
    height: 19px
    typography: 16px / 400
    hover: 'fg #000000'
    pressed: 'fg #000000'
    states: 'rest on 22 header links (11 on home, 11 on recent products); hover and pressed sampled on 21 of them (42 frames), each recording colour #333333 to #000000 and nothing else; focus frames exist but are not declared'
    use: Header navigation link, home::[data-omd-capture="10"]; NotoSansKR, line height 50px (the height of the row), tracking -0.32px
  header-utility-link:
    type: button
    backgroundColor: transparent
    textColor: '#757575'
    rounded: 0px
    padding: 0px
    height: 14px
    typography: 12px / 400
    states: three per route captured at rest on home and recent products; no state frame in the bundle
    use: Top utility link, home::[data-omd-capture="0"]; NotoSansKR, line height 17px, tracking -0.2px
  header-icon-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 37px 0px 0px
    size: 74px x 56px
    typography: 13px / 400
    states: three per route captured at rest on home and recent products; no state frame in the bundle
    use: Header icon link with its label below the icon (a.heart and two siblings), home::[data-omd-capture="6"]; the 37px top padding holds the icon; NotoSansKR, line height 18.98px, tracking -0.3px
  section-more-link:
    type: button
    backgroundColor: transparent
    textColor: '#757575'
    rounded: 0px
    padding: 0px 12px 0px 0px
    height: 20px
    typography: 14px / 400
    states: one captured at rest on home; no state frame in the bundle
    use: Section heading more link (a.c-title__more), home::[data-omd-capture="146"]; Pretendard, line height 20px
  product-tag:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#333333'
    rounded: 0px
    padding: 0px 4px
    height: 21px
    typography: 12px / 400
    states: 13 captured at rest in the home product cards; no state frame in the bundle
    use: 'Product-card tag: a list item that holds its own text, home::li (top 1407); Pretendard, line height 21px'
  recent-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#666666'
    rounded: 0px
    padding: 12px 16px
    height: 52px
    typography: 20px / 500
    selected: 'fg #000000, 20px / 600'
    states: 'two tabs captured on recent products: the rest tab (capture 76) and the tab with class active (capture 77); no state frame in the bundle'
    use: Recent-products page tab (a.tab), surface-2::[data-omd-capture="76"]; NotoSansKR, line height 28px, tracking -0.036px; each tab is 453 px wide
  mylotte-menu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#757575'
    rounded: 0px
    padding: 0px
    height: 21px
    typography: 14px / 400
    states: 19 captured at rest on recent products (captures 55-73); no state frame in the bundle
    use: Account-page menu link on recent products, surface-2::[data-omd-capture="55"]; NotoSansKR, line height 21px, tracking -0.42px
  mylotte-outline-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    border: '1px #dddddd'
    rounded: 6px
    padding: 0px
    size: 178px x 40px
    typography: 13px / 400
    states: two captured at rest on recent products (captures 74 and 75); no state frame in the bundle
    use: Outlined link on recent products, surface-2::[data-omd-capture="74"]; NotoSansKR, line height 38px, tracking -0.26px
  outline-pill-link:
    type: button
    backgroundColor: transparent
    border: '1px #000000'
    rounded: 24px
    size: 242px x 48px
    states: one captured at rest on recent products; no state frame in the bundle
    use: Outlined pill link (a.anchor) in the recent-products content, surface-2::[data-omd-capture="78"]. The anchor computes 16px / 400 with the 16px line height of the content area, which is inherited container type, so no label style is declared
  footer-menu-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px
    height: 15px
    typography: 13px / 400
    states: nine captured at rest on recent products (captures 80-88); capture 83 computes 700; no state frame in the bundle
    use: Footer menu link, surface-2::[data-omd-capture="80"]; NotoSansKR, line height 21.32px, tracking -0.3px
  footer-bordered-link:
    type: button
    backgroundColor: transparent
    textColor: '#757575'
    border: '1px #dddddd'
    rounded: 2px
    padding: 0px 6px
    height: 22px
    typography: 11px / 400
    states: four captured at rest on recent products (links 94-97 in bordered list items); no state frame in the bundle
    use: 'Small bordered footer link: the list item holds the border, radius, padding and 22px height, and the link inside it (surface-2::[data-omd-capture="94"]) holds the text; NotoSansKR, line height 22px, tracking -0.1px'
fonts:
  roles:
    commerce: Pretendard
    navigation: NotoSansKR
---

# 롯데ON

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 롯데ON; reproduced for educational reference. Full prose: https://oh-my-design.kr/lotteon/design.md
