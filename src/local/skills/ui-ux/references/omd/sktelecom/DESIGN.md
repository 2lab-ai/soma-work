---
name: SK텔레콤
colors:
  brand-link: '#3a46cd'
  foreground: '#1a2232'
  strong: '#3a404e'
  muted: '#595e6b'
  hairline: '#d0d1d3'
  action-fill: '#727887'
  on-action: '#ffffff'
typography:
  body:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 27
    use: Repeated public page body text
  navigation:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 20
    use: Brand-page navigation links
  display:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 38.4
    use: Observed SKT Sans Display body-heading treatment; not a complete type scale
rounded:
  square: 0px
  media-tile: 16px
spacing:
  xs: 6
  sm: 12
  md: 16
  lg: 24
  xl: 40
components:
  brand-current-link:
    type: listItem
    textColor: '#3a46cd'
    padding: 0px
    typography: 16px / 600 / SKT Sans Text
    use: 'Static current-page link in the brand-page local navigation (a.depth2-link depth2-brand is-active at surface-2::[data-omd-capture="11"], 168 x 20 px); it is the selected state of lnb-link. Corrected 2026-09-30: padding is 0px; the July value 0px 12px belongs to the section links (brand-section-link)'
  resource-download:
    type: listItem
    backgroundColor: transparent
    textColor: '#1a2232'
    border: '1px solid #727887'
    rounded: 0px
    padding: 11px 24px
    typography: 13px / 600 / SKT Sans Text
    states: default captured on both download links (surface-2 captures 13 and 14). Their hover and pressed frames record bg rgba(74, 80, 143, 0.027) and their focus frames rgba(74, 80, 143, 0.16), two points on one line from transparent, with text colours that differ by one unit between the two links, so they are transition frames and no state value is declared
    use: Public brand-page download link
  outline-title-link:
    type: listItem
    backgroundColor: transparent
    textColor: '#595e6b'
    border: '1px solid #d0d1d3'
    rounded: 0px
    padding: 6px 12px 6px 16px
    height: 34
    typography: 12px / 600 / SKT Sans Text
    use: Public footer/title link
  top-action:
    type: button
    backgroundColor: '#727887'
    textColor: '#ffffff'
    rounded: 0px
    padding: 1px 6px
    height: 58
    typography: 10px / 700 / SKT Sans Text
    states: 'default observed; the capture holds no state frame for this control, so no hover, focus, pressed, disabled, or error state is retained. Corrected 2026-09-30: the July text derived this from interaction count 0, which counts dialog, tab and menu expansions, not pointer-state frames'
    use: Public desktop/tablet top action
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  brand-section-link:
    type: tab
    backgroundColor: transparent
    textColor: '#595e6b'
    rounded: 0px
    padding: 0px 12px
    height: 74px
    typography: 16px / 600 / SKT Sans Text
    selected: 'fg #3a46cd, 16px / 700'
    hover: 'fg #3a46cd, 16px / 700'
    pressed: 'fg #3a46cd, 16px / 700'
    states: 'rest sampled on five section links (captures 2-6). The link with class is-active (capture 1, the current section on this route) computes #3a46cd and 700; no aria-selected is recorded, so that pairing rests on the class name. Capture 2''s hover and pressed frames record exactly those values (rgb(58, 70, 205), 700). Captures 3-6 record 700 in every frame, but their colours lie on the line from the rest #595e6b toward #3a46cd, so they are transition frames: the weight change is settled on all five links, the colour on the one that finished. Focus is not declared from the bundle'
    use: Brand-page header section link (a.sub-depth1-link) at surface-2::[data-omd-capture="2"]; 59-90 px wide, line height 20px
  lnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#727887'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 16px / 600 / SKT Sans Text
    selected: 'fg #3a46cd'
    hover: 'fg #3a46cd'
    pressed: 'fg #3a46cd'
    states: rest sampled on four local-navigation links (captures 8, 9, 10, 12). Every hover and pressed frame of all four records rgb(58, 70, 205) with weight 600 in every frame, exactly the rest colour of the is-active link (capture 11), so the value is settled. Their focus frames record the same colour; focus is not declared from the bundle
    use: Brand-page local navigation (LNB) link (a.depth2-link) at surface-2::[data-omd-capture="8"]; 168 px wide, line height 20px
  intro-tile:
    type: card
    rounded: 16px
    size: 260px wide, 114-228px tall
    typography: 20px / 700 / SKT Sans Text
    states: 13 tiles captured at rest. Each records a pressed frame in which the anchor's own colour moves from rgb(0, 0, 238) to rgb(255, 0, 0), Chromium's default link and active-link colours; the tile text is set by child p elements, so that colour never renders and no pressed value is declared
    use: 'Home service tile (a.item intro-imgNN-target) at home::[data-omd-capture="0"]. The font is the child p.title (20px / 700 / 26px; one tile 18px / 700 / 27px); p.desc is 13px / 600 / 20.8px, tracking -0.13px. The labels compute #ffffff on most tiles, #1a2232 on two (item-safety, item-investor) and #3a46cd on one (item-adot), so no single text colour is declared'
  newsroom-card:
    type: card
    textColor: '#1a2232'
    rounded: 0px
    size: 311px x 271px
    typography: 14px / 500 / SKT Sans Text
    states: 'eight cards captured at rest (captures 13-20: four a.newsroom-link, four a.news-link, 248-271 px tall). Their pressed frames move only the anchor''s default link colour (rgb(0, 0, 238) to rgb(255, 0, 0)), which the child text does not use, so no pressed value is declared'
    use: Home newsroom card (a.newsroom-link) at home::[data-omd-capture="13"]; text colour and font are the child p.text (295 px wide, line height 22.4px)
  footer-menu-link:
    type: button
    backgroundColor: transparent
    textColor: '#3a404e'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 14px / 500 / SKT Sans Text
    states: 'rest captured on home (captures 21-23) and on the brand page (captures 52-54). The home links'' hover and pressed frames all record rgb(23, 26, 32), which lies on the line from the rest #3a404e to #000000 (58, 64, 78 x 0.404 = 23.43, 25.86, 31.51, rounding to 23, 26, 32), so it is treated as a transition frame and no hover or pressed value is declared'
    use: Footer menu link (first footer row) at home::[data-omd-capture="21"]; 51-89 px wide, line height 20px, tracking -0.56px
  footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#727887'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 12px / 600 / SKT Sans Text
    states: 'default captured on both surfaces; no state frame. The first link (a.link strong, capture 31) computes #3a404e at the same size and weight'
    use: Footer policy-row link (a.link) at home::[data-omd-capture="32"] (also captures 33-38 and brand-page captures 62-69); tracking -0.48px
  content-row:
    type: button
    backgroundColor: transparent
    textColor: '#3a404e'
    border: '1px #ecedef'
    rounded: 0px
    padding: 24px 24px 0px 0px
    size: 850px wide
    typography: 15px / 600 / SKT Sans Text
    states: 37 rows captured at rest on the brand page; 15 carry the top border and 24px top padding, 22 have neither (0px 24px 0px 0px). No state frame
    use: Brand-page content row (button.content) at surface-2::[data-omd-capture="18"]. The root computes the inherited body text (#000000, 10px / 400 / 11.5px); text colour and font are the child title p.tit (599 px wide, line height 27px), matched by top offset
fonts:
  roles:
    ui: SKT Sans Text
    display: SKT Sans Display
---

# SK텔레콤

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SK텔레콤; reproduced for educational reference. Full prose: https://oh-my-design.kr/sktelecom/design.md
