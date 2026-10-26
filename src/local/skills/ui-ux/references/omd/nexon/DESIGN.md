---
name: Nexon
colors:
  primary: '#0077ff'
  ink: '#17191d'
  muted: '#737881'
  label: '#4a4e57'
  helper: '#9fa1a7'
  pill-ink: '#080410'
  canvas: '#ffffff'
  input-ink: '#222426'
  input-line: '#dde1e5'
  guide-ink: '#222222'
  guide-meta: '#51555d'
  guide-disabled: '#a1a7b5'
typography:
  gnb:
    fontSize: 16px
    fontWeight: 400
    use: 'Portal GNB menu link in NEXON Gothic (the portal''s name for NEXON Lv.1 Gothic), #17191d'
  section:
    fontSize: 24px
    fontWeight: 400
    use: Portal section heading (h2) set in the NEXON Gothic Bold family, which registers the Lv.1 Gothic Bold cut at weight 400
  card-title:
    fontSize: 16px
    fontWeight: 400
    use: Portal game-card title in the NEXON Gothic Bold family
  utility:
    fontSize: 14px
    fontWeight: 400
    letterSpacing: '-0.4px'
    use: Portal utility links (보안센터, PC방 찾기) in NEXON Gothic
  body:
    fontSize: 12px
    fontWeight: 400
    use: Portal body and small print; declares the system face malgun gothic, so no brand face is claimed for it
  guide-display:
    fontSize: 52px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.52px'
    use: Brand-guide section display (Brand Articles) in KlavikaNX, 57.2px line
  guide-article-title:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: '-0.18px'
    use: Brand-guide article card title in Pretendard, 28.8px line
  guide-article-text:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: '-0.16px'
    use: Brand-guide article excerpt in Pretendard, 27.2px line
rounded:
  pill: 19px
  badge: 7px
  guide-button: 4px
spacing:
  gnb-top: 23
  gnb-x: 23
  pill-x: 18
  game-card-media: 224
components:
  gnb-link:
    type: tab
    textColor: '#17191d'
    padding: 23px 23px 21px
    height: 62px
    typography: 16px / 400 NEXON Gothic
    states: rest only; the bundle holds no state frame for this link (capture 1)
    use: Portal GNB menu link at home::[data-omd-capture="1"], 107 x 62
  gnb-icon-link:
    type: tab
    textColor: '#17191d'
    padding: 21px 0px 0px
    size: 22px x 62px
    typography: 14px / 400 NEXON Gothic
    hover: 'fg #0077ff on the anchor; the icon span''s own hover value is outside the capture'
    pressed: 'fg #0077ff on the anchor, the same frame as hover'
    states: 'settled frames: four sibling GNB links (captures 2-5) record the identical #0077ff for hover and pressed; focus is not declared'
    use: 'Portal GNB icon link at home::[data-omd-capture="2"], 22 x 62; its visible glyph is a 22 x 22 span (one records bg #191919), the label text is hidden'
  gnb-pill-link:
    type: button
    textColor: '#080410'
    border: '2px #17191d'
    rounded: 19px
    padding: 7px 18px 0px
    height: 36px
    typography: 15px / 400 NEXON Gothic Bold
    states: 'a single element, so sibling agreement is unavailable; its hover and pressed frames both record bg #0077ff, fg #ffffff and a 2px #0077ff border, exact values equal to the blue the four GNB icon links settle on; kept as a recorded frame rather than declared hover or pressed keys'
    use: Portal GNB outline pill link (three-character label) at home::[data-omd-capture="6"], 85 x 36
  gnb-badge:
    type: badge
    backgroundColor: '#0077ff'
    textColor: '#ffffff'
    rounded: 7px
    padding: 0px 3px 0px 4px
    size: 14px x 14px
    typography: 10px / 400
    use: Portal GNB notification count badge (span.gnbBadge) at home::span, set on a GNB icon
  login-box-action:
    type: button
    backgroundColor: '#17191d'
    textColor: '#ffffff'
    rounded: 0px
    padding: 22px 0px 0px
    height: 60px
    typography: 15px / 400 NEXON Gothic Bold
    states: rest only; the bundle holds no state frame for capture 29
    use: Portal login-box primary link, a 353 x 60 dark block at home::[data-omd-capture="29"]; the green button below it (a.naver-login-btn, 네이버 로그인) is Naver's sign-in and is excluded as a third-party brand element
    pressed: 'bg #0077ff (:hover + :active)'
  search-input:
    type: input
    textColor: '#222426'
    border: 'bottom 1px #dde1e5'
    rounded: 0px
    padding: 0px 3px
    height: 44px
    typography: 12px / 400
    states: rest only; the bundle holds no state frame for capture 40
    use: Portal game search field at home::[data-omd-capture="40"], 302 x 44, underline only, letter-spacing -0.3px; its text declares the system face malgun gothic
  game-card:
    type: card
    textColor: '#17191d'
    padding: 224px 0px 0px
    size: 302px x 320px
    typography: 16px / 400 NEXON Gothic Bold
    use: 'Portal game grid card (a) at home::[data-omd-capture="42"]: a 224px image area above the title; 39 cards in the grid, each with a 20 x 20 #737881 icon link beside it'
  game-tile:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    size: 153px x 342px
    states: 'hover and pressed frames record box-shadow rgba(0, 0, 0, 0) 0px 0px 0px 0px while other frames record blur values that differ tile to tile (1.3332px to 1.33992px): the collector sampled a shadow transition in flight, so the settled hover is unmeasured and none is declared'
    use: 'Portal featured-game carousel tile (a) at home::[data-omd-capture="16"], eleven tiles; the first (capture 15) carries a 2px #f78029 bottom border'
  guide-arrow-button:
    type: button
    backgroundColor: '#222222'
    border: '1px #222222'
    rounded: 0px
    size: 40px x 40px
    disabled: 'bg #a1a7b5, 1px #a1a7b5 border, icon #adb5bd (capture 9, disabled at capture time)'
    states: 'the enabled button is a single element, so sibling agreement is unavailable; its hover and pressed frames both record bg #ffffff with the 1px #222222 border kept, recorded here rather than declared as hover or pressed keys'
    use: Brand-guide carousel arrow button at surface-2::[data-omd-capture="10"]
  guide-language-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#2e2e2e'
    border: 1px transparent
    rounded: 4px
    size: 44px x 42px
    typography: 16px / 600 / 16px Pretendard
    states: the pressed frame records the rest values in every captured property; no hover frame
    use: Brand-guide header language button (KO) at surface-2::[data-omd-capture="4"]
  guide-family-site-select:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    border: 'bottom 1px #a1a7b5'
    padding: 11px 0px
    height: 43px
    typography: 16px / 400 / 24.8px Pretendard
    states: 'the collector''s menu interaction opened a 250 x 298 dropdown: bg #000000, 1px #e9ecef border, 8px 0px padding, items 248 x 40 in #ffffff 16px / 400 / 24.8px with 0px 12px padding'
    use: Brand-guide footer family-site select at surface-2::[data-omd-capture="17"], 248 x 43
  guide-article-card:
    type: card
    rounded: 0px
    size: 342px x 521px
    use: 'Brand-guide article card (a) at surface-2::[data-omd-capture="11"], five in a row: a 342 x 342 image over a #51555d 15px / 400 / 15px date, a #000000 18px / 500 / 28.8px title and a 16px / 400 / 27.2px excerpt; the anchor''s own 16px / 400 black equals the body''s inherited text, so no card-level label style is claimed'
fonts:
  roles:
    ui: NEXON Gothic
    identity: KlavikaNX
---

# Nexon

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Nexon; reproduced for educational reference. Full prose: https://oh-my-design.kr/nexon/design.md
