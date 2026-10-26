---
name: Kakao
colors:
  login: '#fee500'
  login-symbol: '#000000'
  login-label: '#000000'
  marketing: '#fae100'
  dark-marketing: '#111111'
  canvas: '#ffffff'
  foreground: '#333333'
  on-dark: '#ffffff'
  muted: '#888888'
  surface: '#eeeeee'
  border: '#dbdbdb'
typography:
  display:
    fontSize: 53.82px
    fontWeight: 700
    lineHeight: 66px
    letterSpacing: '-1px'
  heading:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 40px
  title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 42px
  nav:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 27px
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 21px
  body-readable:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 24.92px
    letterSpacing: '-0.2px'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: '-0.2px'
rounded:
  login: 12px
  marketing: 16px
  search: 18px
  footer: 24px
  filter: 30px
  full: 999px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 16
  xl: 20
components:
  kakao-login:
    type: button
    backgroundColor: '#fee500'
    textColor: rgba(0, 0, 0, 0.85)
    rounded: 12px
    typography: 30Pt / OS system
    states: full label or shortened label; hover, pressed, and disabled visuals are not specified by this guide
    use: Kakao Login only; preserve black speech-bubble symbol and mandated colors
  corporate-nav:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 999px
    padding: 4px 16px 6px
    height: 37px
    typography: 17px / 400 / KakaoBig
    hover: 'bg #f3f3f3'
    pressed: 'bg #f3f3f3'
    focus: 'bg #f3f3f3'
    states: 'light and dark theme variants; hover and pressed bg #f3f3f3 in the 2026-07-11 capture on three corporate pages and again on 2026-09-29 with :hover and :active matched; keyboard focus (Tab stop 4, :focus-visible matched) fills bg #f3f3f3 beside the browser default ring (outline auto); the fill stayed after focus moved on, which suggests a script-applied current-item state (a lead, not a finding)'
    use: top-level corporate menu trigger
  search-control:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 18px
    height: 36px
    typography: 14px / 400 / KakaoSmall
    hover: 'bg #eeeeee'
    pressed: 'bg #eeeeee'
    states: 'hover and pressed bg #eeeeee, measured 2026-09-29 on the corporate home with :hover and :active matched and sampled 2026-07-11 on the search, language and theme buttons of the corporate pages; keyboard focus draws only the browser default ring (outline auto), so no focus value is declared; the search input opens in a layer behind a click and was not measured'
    use: corporate-site circular search control; the language and theme toggles share the same 36px circle
  dark-marketing-tag:
    type: badge
    backgroundColor: '#111111'
    textColor: '#ffffff'
    border: '2px solid #ffffff'
    rounded: 16px
    padding: 7px 8px 8px
    height: 32px
    typography: 13px / 700 / KakaoSmall
    hover: bg rgba(17, 17, 17, 0.75)
    pressed: bg rgba(17, 17, 17, 0.75)
    states: hover and pressed bg rgba(17, 17, 17, 0.75), sampled 2026-07-11 and confirmed 2026-09-29 with :hover and :active matched; border and label stay as at rest; keyboard focus draws only the browser default ring (outline auto), so no focus value is declared
    use: dark corporate marketing tag/CTA label
  milestone-filter:
    type: button
    backgroundColor: '#eeeeee'
    textColor: '#000000'
    rounded: 30px
    padding: 8px 20px 12px
    height: 44px
    typography: 16px / 700 / KakaoBig
    pressed: 'bg #dfdfdf'
    states: 'selected filter captured; pressed bg #dfdfdf from one 2026-07-11 frame on the category combobox (surface-3::[data-omd-capture="15"]); hover and focus not sampled'
    use: milestone category filter
  footer-pill:
    type: button
    backgroundColor: '#eeeeee'
    textColor: '#000000'
    rounded: 24px
    padding: 10px 20px 12px
    height: 40px
    typography: 12px / 400 / KakaoSmall
    states: 'default captured 2026-07-11 on the milestones page; on 2026-09-29 the same pill on the corporate home matched :hover and :active and kept bg #eeeeee and fg #000000, so there is no hover or pressed value to declare; keyboard focus draws only the browser default ring (outline auto)'
    use: corporate footer related-site pill
  marketing-download-cta:
    type: button
    backgroundColor: '#fae100'
    textColor: '#000000'
    border: '2px solid #000000'
    rounded: 16px
    padding: 7px 13px 8px 30px
    height: 32px
    typography: 13px / 700 / KakaoSmall
    states: default captured 2026-07-11 (home::[data-omd-capture="10"], 142 x 32, tracking -0.5px); on 2026-09-29 hover and pressed matched :hover and :active and left fill, border and label at rest, so no hover or pressed value is declared; keyboard focus draws only the browser default ring (outline auto), so no focus value is declared
    use: 'Corporate-home marketing download pill (a.btn_top.btn_down, 카카오톡 다운로드) beside the dark marketing tag; the only #fae100 element in the capture'
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  service-card:
    type: card
    backgroundColor: transparent
    textColor: '#111111'
    padding: 0px 16px 0px 0px
    size: 288px x 299px
    typography: 30px / 700
    hover: icon opacity 1 via title ::after (24 x 24 SVG)
    pressed: icon opacity 1 via title ::after (24 x 24 SVG)
    states: 'rest, hover and pressed measured 2026-09-29 with :hover and :active matched: the title ::after icon goes from opacity 0 to 1 and nothing recolours, moves or casts a shadow; keyboard focus draws only the browser default ring (outline auto), so no focus value is declared; fg and font are the title label (strong.title_service), not the anchor (#333333, 14px / 400 / KakaoBig); not in the 2026-07-11 capture'
    use: Corporate-home service card link (a.item_service) with a 120px service image, title and description
  milestone-service-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    height: 20px
    typography: 14px / 400 / KakaoSmall
    hover: 'fg #111111'
    pressed: 'fg #111111'
    states: 'default, hover and pressed sampled 2026-07-11 on three sibling links (surface-3 captures 21, 22 and 23), each fg #333333 to #111111, the dark-marketing colour; focus not sampled (the 2026-09-29 probe covered the corporate home only)'
    use: Milestones-page service-name text link (a.link_service in li.item_service, 35 in the list); line height 24.92px, tracking -0.2px
  culture-carousel-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #dbdbdb'
    rounded: 50%
    size: 50px x 50px
    typography: 14px / 400 / KakaoSmall
    states: default captured 2026-07-11 (surface-2::[data-omd-capture="11"]); no pointer-state sample
    use: 'Culture-page circular carousel control (button.btn_control); the element behind the #dbdbdb border token'
fonts:
  roles:
    display: KakaoBig
    text: KakaoSmall
    login: System
---

# Kakao

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kakao; reproduced for educational reference. Full prose: https://oh-my-design.kr/kakao/design.md
