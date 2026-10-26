---
name: ZIGZAG
colors:
  strong: '#121212'
  canvas: '#ffffff'
  foreground: '#292b2b'
  secondary: '#606567'
  muted: '#878f91'
  hairline: '#ecedee'
typography:
  heading:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0px
    use: Public product-detail section headings
  body:
    fontSize: 16px
    fontWeight: 400
    use: Current page and product-card text
  metadata:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.21
    letterSpacing: 0px
    use: Product-detail tab and supporting metadata
rounded:
  square: 0px
  icon: 8px
  control: 24px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
components:
  product-thumbnail:
    type: card
    backgroundColor: '#ecedee'
    rounded: 0px
    use: Public product-card thumbnail placeholder on both captured product-detail pages
  product-card:
    type: card
    rounded: 0px
    padding: 0px 0px 8px
    hover: no change in the compared scope (the card link a.product-card-link, its ::before/::after, 0 descendants, 3 ancestor levels; the thumbnail and texts are siblings of the link and were not compared) — measured 2026-09-29
    pressed: bg rgba(0, 0, 0, 0.03) on the card link
    focus: no focus indication in the compared scope (same scope as hover) — measured 2026-09-29
    states: root captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on the link inside the first product card on product-a (172px x 336.4px, Tab 13) in the second run; the first run's hover and pressed were voided when the page navigated away
    use: Public product-card root on both captured product-detail pages
  detail-tab:
    type: tab
    textColor: '#121212'
    rounded: 0px
    padding: 0px 4px 17.5px
    typography: 14px / 600
    active: '#121212'
    hover: no change in the compared scope (self, its ::before/::after, 3 descendants, 3 ancestor levels) on the selected 상품정보 and the default 성분 — measured 2026-09-29
    pressed: no change in the compared scope (same scope) on the selected tab — measured 2026-09-29
    focus: no focus indication in the compared scope (same scope) on the selected tab (Tab 32) — measured 2026-09-29
    states: 'selected captured 2026-07-13; the default tab uses #878f91 at 14px / 500 with padding that varies by tab (0px 4px 17.5px on 성분, 0px 4px 10px on 리뷰 in the 2026-09-29 survey; July sampled 10px); 성분''s pressed state is unmeasured (the page changed on mouse-down) and its focus is unmeasured (tabIndex -1 in a roving tablist)'
    use: Product-detail tab list on both captured product-detail pages
  quick-menu-arrow:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #ecedee'
    rounded: 50%
    disabled: rgba(16,16,16,0.3)
    hover: no change in the compared scope (self, its ::before/::after, 2 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    pressed: bg rgba(0, 0, 0, 0.05)
    focus: no focus indication in the compared scope (same scope as hover) — measured 2026-09-29
    states: default captured 2026-07-13; the previous arrow is a natively disabled button (disabled attribute, pointer-events none) with rgba(16,16,16,0.3) text, confirmed 2026-09-29; hover, pressed and keyboard focus measured 2026-09-29 on the next arrow 다음 (Tab 76)
    use: Home quick-menu carousel arrow
  tabbar-link:
    type: tab
    backgroundColor: transparent
    textColor: '#121212'
    rounded: 0px
    size: 150px x 59px
    typography: '11px / 500 (visible label; the link itself computes #292b2b 16px / 400)'
    hover: overlay ::before rgba(0, 0, 0, 0.05), full size
    pressed: overlay ::before rgba(0, 0, 0, 0.05); bg rgba(0, 0, 0, 0.05); transform icon svg scale 0.95
    focus: no focus indication in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-13 on four links (the first and last round their outer top corner at 12px); hover, pressed and keyboard focus measured 2026-09-29 on 카테고리 (Tab 366)
    use: Fixed bottom tab bar link (홈, 카테고리, 찜, 마이페이지) at home::[data-omd-capture="78"] to [data-omd-capture="81"]
  header-icon-link:
    type: button
    backgroundColor: transparent
    textColor: '#292b2b'
    rounded: 8px
    padding: 0px
    size: 44px x 44px
    hover: bg rgba(0, 0, 0, 0.03)
    pressed: bg rgba(0, 0, 0, 0.03)
    focus: no focus indication in the compared scope (self, its ::before/::after, 3 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-13 (two on home, three on each product page); hover, pressed and keyboard focus measured 2026-09-29 on the product-page 검색 link (Tab 4, second run); hover equals pressed; the July hover, pressed and focus frames on these links (alpha 0.004 and 0.008) were transition frames and are not used
    use: Header icon link (검색 and its siblings; no text node) at surface-2::[data-omd-capture="2"] to [data-omd-capture="4"]
  carousel-next:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 9999px
    padding: 6px
    size: 32px x 32px
    shadow: 0px 2px 8px rgba(0, 0, 0, 0.1)
    hover: no change in the compared scope (self, its ::before/::after, 2 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 2 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    focus: no focus indication in the compared scope (self, its ::before/::after, 2 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-13 on both product pages; hover, pressed and keyboard focus measured 2026-09-29 on product-a's product-card carousel next arrow (Tab 29, second run)
    use: White circular product-card carousel arrow at surface-2::[data-omd-capture="26"]
  buy-cta:
    type: button
    backgroundColor: '#121314'
    textColor: '#fafafb'
    rounded: 24px
    padding: 0px
    size: 460px x 46px
    typography: 17px / 700
    focus: no focus indication in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    states: 'default captured 2026-07-13 on both product pages; keyboard focus measured 2026-09-29 (Tab 238); hover and pressed deliberately unmeasured: the button was never pressed, because another zigzag control had just fired on mouse-down'
    use: Fixed bottom 구매하기 purchase button at surface-2::[data-omd-capture="37"]
    height: 46px
  more-button:
    type: button
    backgroundColor: transparent
    textColor: '#242729'
    rounded: 24px
    padding: 0px
    size: 98px x 48px
    typography: 15px / 600
    focus: no focus indication in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    states: 'default captured 2026-07-13; keyboard focus measured 2026-09-29 (Tab 34); hover and pressed unmeasured: the button is pointer-events none, and its 1px #292b2b pill border is drawn by its parent div, not by the button'
    use: 상품정보 더 보기 pill at surface-2::[data-omd-capture="33"]
  app-banner-button:
    type: button
    backgroundColor: '#f1ecea'
    textColor: '#000000'
    rounded: 0px
    padding: 0px 17px
    size: 600px x 54px
    typography: 16px / 400
    states: default captured 2026-07-13 on all three surfaces; not probed
    use: Top 앱으로 이동 app banner at home::[data-omd-capture="0"]
  floating-scroll-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 50%
    padding: 0px
    size: 40px x 40px
    shadow: 0px 2px 6px rgba(0, 0, 0, 0.08)
    states: default captured 2026-07-13 (four occurrences on the two product pages); not probed
    use: White circular scroll button on the product page at surface-2::[data-omd-capture="38"]
  text-action:
    type: button
    backgroundColor: transparent
    textColor: '#606567'
    rounded: 0px
    padding: 0px
    size: 63px x 20px
    typography: 13px / 500
    states: default captured 2026-07-13 on both product pages; not probed
    use: 전체보기 text action at surface-2::[data-omd-capture="8"]
---

# ZIGZAG

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ZIGZAG; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/zigzag/DESIGN.md
