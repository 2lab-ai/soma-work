---
name: Ohouse
colors:
  action: '#00a1ff'
  foreground: '#2f3438'
  body: '#424242'
  muted: '#828c94'
  canvas: '#ffffff'
  hairline: '#e0e0e0'
typography:
  display:
    fontSize: 30px
    fontWeight: 400
    lineHeight: 30
    letterSpacing: '-0.3px'
    use: Observed h1 on the consumer home
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 15
    letterSpacing: '-0.3px'
    use: Observed list, card, and text content on the consumer home
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24
    letterSpacing: '-0.3px'
    use: Observed body content on the consumer home
  action:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 20
    letterSpacing: '-0.3px'
    use: Observed text action on the consumer home
  compact-action:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 18
    letterSpacing: '-0.3px'
    use: Observed compact blue action
rounded:
  square: 0px
  sm: 4px
  full: 24px
spacing:
  xs: 6
  sm: 12
  md: 16
  lg: 20
components:
  product-list-article:
    type: card
    backgroundColor: transparent
    textColor: '#424242'
    rounded: 0px
    padding: 0px
    typography: 15px / 400 / Pretendard Variable
    hover: no change in the compared scope (the overlay link a.today-deal-item__overlay, its ::before/::after, 0 descendants, 3 ancestor levels; the card image and text are siblings of the link and were not compared) — measured 2026-09-29
    pressed: no change in the compared scope (same scope as hover) — measured 2026-09-29
    focus: 'shadow #69c3fd 0 0 0 4px ring and radius 0px → 2px on the overlay link (authored, no outline) — measured 2026-09-29'
    states: default captured 2026-07-13 on the outer article; hover, pressed and keyboard focus measured 2026-09-29 on the empty overlay link inside the first today-deal card (269px x 404px, Tab 88)
    use: Observed outer product-list article shell on the consumer home
  compact-blue-action:
    type: button
    backgroundColor: '#00a1ff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 16px
    size: 91px x 40px
    typography: 14px / 400 / Pretendard Variable
    hover: 'bg #0497ef'
    pressed: 'bg #0497ef'
    focus: 'shadow #ddf3ff 0 0 0 3px (authored ring, no outline); bg #0497ef — measured 2026-09-29'
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on 글쓰기 (Tab 14), logged out and never activated; hover equals pressed
    use: Header 글쓰기 action at home::[data-omd-capture="9"]; one captured occurrence
  circular-floating-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#ffffff'
    rounded: 24px
    padding: 0px
    size: 48px x 48px
    typography: 16px / 700 / Pretendard Variable
    shadow: 0px 2px 5px rgba(63, 71, 77, 0.15)
    hover: 'bg #f7f9fa'
    pressed: 'bg #f7f9fa'
    focus: 'bg #f7f9fa (background tint only, no ring or outline) — measured 2026-09-29'
    states: default captured 2026-07-13 (seven occurrences, no text content); hover, pressed and keyboard focus measured 2026-09-29 on the first 집사진 carousel 다음 arrow (Tab 59); focus equals hover
    use: Circular carousel arrow at home::[data-omd-capture="20"]
  outlined-utility-control:
    type: button
    backgroundColor: transparent
    textColor: '#2f3438'
    border: '1px solid #e0e0e0'
    rounded: 4px
    padding: 0px 8px
    size: 182px x 32px
    typography: 14px / 400 / Pretendard Variable
    states: default captured 2026-07-13 only (an 80px link at capture 128 shares the class); absent from the home page on 2026-09-29 at 1440x1000, so no state was measured
    use: Utility control near the foot of home at home::[data-omd-capture="127"]
  text-action:
    type: button
    backgroundColor: transparent
    textColor: '#00a1ff'
    rounded: 0px
    padding: 0px
    size: 41px x 20px
    typography: 16px / 700 / Pretendard Variable
    hover: opacity 1 → 0.5
    pressed: opacity 1 → 0.5
    focus: no focus indication in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-13 (six occurrences); hover, pressed and keyboard focus measured 2026-09-29 on the first 더보기 (Tab 37); the label is the button itself
    use: Blue 더보기 text action at home::[data-omd-capture="32"]
  top-nav-search-input:
    type: input
    backgroundColor: transparent
    textColor: '#141414'
    rounded: 0px
    padding: 0px
    size: 255px x 20px
    typography: 14px / 400 / Pretendard Variable
    hover: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    focus: no focus indication in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on 통합검색 (Tab 9); nothing was typed; any search dropdown lies outside the compared scope
    use: Header 통합검색 input at home::[data-omd-capture="4"]
  primary-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#2f3438'
    rounded: 0px
    padding: 21px 5px
    size: 41px x 60px
    typography: 18px / 700 / Pretendard Variable
    selected: 'fg #00a1ff (the current section, 집구경)'
    hover: 'fg #00a1ff'
    pressed: 'fg #00a1ff'
    focus: 'fg #00a1ff; shadow #ddf3ff 0 0 0 3px on the label span (authored ring, no outline) — measured 2026-09-29'
    states: default and selected captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on 쇼핑 (Tab 7), label span.css-1w2ex0u; hover equals pressed
    use: Header section link (집구경, 쇼핑, 인테리어/생활) at home::[data-omd-capture="1"] to [data-omd-capture="3"]
  header-subnav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#424242'
    rounded: 0px
    padding: 12px 6px
    height: 51px
    typography: 15px / 400 / Pretendard Variable
    states: default captured 2026-07-13 on six links; not probed
    use: Second header row of text links at home::[data-omd-capture="10"] to [data-omd-capture="15"]
  header-utility-link:
    type: tab
    backgroundColor: transparent
    textColor: '#2f3438'
    rounded: 0px
    padding: 0px 10px
    height: 18px
    typography: 14px / 400 / Pretendard Variable
    states: 'default captured 2026-07-13; 회원가입 and 고객센터 carry a 1px #eaedef left border that divides the three; not probed'
    use: Header 로그인 / 회원가입 / 고객센터 links at home::[data-omd-capture="6"] to [data-omd-capture="8"]
  scrap-toggle:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    size: 36px x 36px
    states: default captured 2026-07-13 (14 occurrences, no text node; the icon is an SVG whose paint was not captured); not probed
    use: Scrap toggle on home content cards at home::[data-omd-capture="33"]
fonts:
  roles:
    ui: Pretendard Variable
---

# Ohouse

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ohouse; reproduced for educational reference. Full prose: https://oh-my-design.kr/ohouse/design.md
