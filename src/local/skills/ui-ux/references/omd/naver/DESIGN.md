---
name: Naver
colors:
  brand: '#03c75a'
  canvas: '#ffffff'
  portal-ink: '#2e2e2e'
  search-ink: '#1c1c1c'
  search-link: '#0c43b7'
  search-muted: '#8c8c8c'
  hairline: '#e5e5e5'
  corporate-ink: '#1a1d24'
  corporate-muted: '#717680'
  login-fill: '#03a94d'
typography:
  portal-search:
    fontSize: 21px
    fontWeight: 700
    lineHeight: 24px
    letterSpacing: '-0.4px'
  portal-ui:
    fontSize: 14.7px
    fontWeight: 500
    lineHeight: 17.85px
    letterSpacing: '-0.4px'
  search-tab:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 21px
    letterSpacing: '-0.3px'
  search-title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: '-0.16px'
  corporate-tab:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: '-0.6px'
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 20
components:
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    height: 58px
    padding: 17px 0
    typography: 21px / 700 / System
    states: 'autocomplete listbox expansion observed 2026-07-11; keyboard focus measured 2026-09-29 (Tab stop 15, :focus-visible matched) leaves the input and its six ancestors as at rest, with outline none; the 1px #03c75a ring belongs to the search assembly (div#search_area) and is there without focus; hover adds a shadow to that assembly, not to the input; the input is autofocused on load'
    use: Portal-home search query input inside the branded search assembly
  search-submit:
    type: button
    backgroundColor: transparent
    textColor: '#2e2e2e'
    rounded: 0px
    height: 58px
    padding: 9px 9px 9px 10px
    hover: opacity 0→0.5 blur(4px) glow layer, 0→1 two conic-gradient layers, 1→0 two pale gradient fills; image swap @img_ai_tab_light.png → @img_ai_tab_highlight.png
    pressed: opacity 0→0.5 blur(4px) glow layer, 0→1 two conic-gradient layers, 1→0 two pale gradient fills; image swap @img_ai_tab_light.png → @img_ai_tab_highlight.png
    focus: opacity 0→0.5 glow layer, 0→1 conic-gradient layers, 1→0 pale fills; image swap to @img_ai_tab_highlight.png; shown beside the browser default ring, which is not declared
    states: 'default observed 2026-07-11; hover, pressed and keyboard focus measured 2026-09-29 with :hover, :active and :focus-visible matched: seven text-free layers inside the button change opacity. A blur(4px) glow layer (75 x 44) goes 0 → 0.5 and two 148 x 148 conic-gradient layers go 0 → 1, their gradient angle rotating between reads (no timing is stated); two pale linear-gradient fills, rgb(236, 247, 252) → rgb(232, 249, 245), go 1 → 0; the label image @img_ai_tab_light.png fades out while @img_ai_tab_highlight.png fades in. Pressed equals hover. Keyboard focus runs the same change next to the browser default ring (outline auto) and reverts on blur. Reproduced on a second load (corrected 2026-09-29: earlier text said every compared property stayed at rest, from a read that skipped empty layers)'
    use: Portal AI search control (button#search-ai-tab-button) beside the query field
  serp-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#8c8c8c'
    rounded: 0px
    padding: 6px 12px 14px
    typography: 16px / 600 / System
    hover: 'fg #595959'
    pressed: 'fg #595959'
    states: 'default #8c8c8c; hover and pressed fg #595959'
    use: Search-result vertical navigation
  filter-chip:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#0c43b7'
    border: '1px solid #e5e5e5'
    rounded: 18px
    padding: 4px 12px 4px 4px
    typography: 13px / 400 / System
    use: Search-result image/filter chip
  result-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1c1c1c'
    rounded: 12px
    use: Search-result grouped content card
  paging-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#2e2e2e'
    border: 1px solid rgba(0,0,0,0.15)
    rounded: 9999px
    height: 36px
    shadow: 0 1px 2px rgba(0,0,0,0.06)
    hover: bg rgba(0, 0, 0, 0.06), shadow 0 2px 4px rgba(0, 0, 0, 0.12)
    pressed: bg rgba(0, 0, 0, 0.06), shadow 0 2px 4px rgba(0, 0, 0, 0.12)
    states: 'hover and pressed measured 2026-09-29 on the portal-home previous button with :hover and :active matched (transition: all 0s): bg rgba(0, 0, 0, 0.06) and shadow 0 2px 4px rgba(0, 0, 0, 0.12); keyboard focus draws only the browser default ring (outline auto), so no focus value is declared; corrected 2026-09-29: earlier text said hover and pressed were not retained, and the 2026-09-17 check had measured a search-results control'
    use: Portal carousel previous/next control
  corporate-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#1a1d24'
    rounded: 0px
    padding: 17px 0 18px
    typography: 20px / 600 / InterVariable
    states: selected observed
    use: NAVER Corp brand-resource section switcher
  portal-menu:
    type: listItem
    backgroundColor: transparent
    textColor: '#2e2e2e'
    typography: 14.7px / 500 / System
    states: expanded listbox and option observed
    use: Portal content-header overflow menu option
  login-cta:
    type: button
    backgroundColor: '#03a94d'
    textColor: '#ffffff'
    border: 1px solid rgba(0, 0, 0, 0.06)
    rounded: 4px
    padding: 17px 0px
    size: 380px x 56px
    typography: 14.7px / 500 / System
    shadow: 0 2px 4px rgba(3, 199, 90, 0.12)
    hover: shadow 0 2px 4px rgba(3, 199, 90, 0.24); overlay rgba(0, 0, 0, 0.06) via ::before
    pressed: shadow 0 2px 4px rgba(3, 199, 90, 0.24); overlay rgba(0, 0, 0, 0.06) via ::before
    states: 'default captured 2026-07-11 and the same on 2026-09-29; the fill is #03a94d, darker than brand green #03c75a, which tints only the shadow; hover and pressed measured 2026-09-29 with :hover and :active matched: shadow alpha 0.12 to 0.24 plus a rgba(0, 0, 0, 0.06) ::before overlay (transition: all 0s); keyboard focus draws only the browser default ring (outline auto), so no focus value is declared; no sign-in was attempted'
    use: Portal-home sign-in CTA (NAVER로그인, a.MyView-module__link_login); tracking -0.4px
    height: 56px
  search-assembly:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #03c75a'
    hover: shadow 0 2px 4px rgba(0, 0, 0, 0.12)
    pressed: shadow 0 2px 4px rgba(0, 0, 0, 0.12)
    states: 'measured 2026-09-29: the 1px #03c75a border is present at rest with focus elsewhere and stays through hover, press and keyboard focus; hover and pressed (:hover and :active matched on the input) add shadow 0 2px 4px rgba(0, 0, 0, 0.12) to this container; keyboard focus in the input (Tab stop 15) adds nothing; radius and size were not read, so none is declared'
    use: Portal-home search assembly (div#search_area) that frames the query input, AI search and input tools
  portal-content-tab:
    type: tab
    backgroundColor: transparent
    textColor: rgba(0, 0, 0, 0.5)
    height: 23px
    typography: 17px / 800 / System
    selected: 'fg #000000'
    hover: underline rgba(0, 0, 0, 0.5)
    pressed: underline rgba(0, 0, 0, 0.5)
    states: 'inactive rest, hover and pressed measured 2026-09-29 with :hover and :active matched (tab 엔터): an underline in rgba(0, 0, 0, 0.5) appears and the text colour stays; the selected tab reads fg #000000 in the 2026-07-11 capture (tab-selected); keyboard focus draws only the browser default ring (outline auto), so no focus value is declared'
    use: Portal-home content-header tab (role=tab) above the news and content feed; tracking -0.4px
  service-shortcut:
    type: button
    backgroundColor: transparent
    textColor: '#2e2e2e'
    size: 64px x 68px
    typography: 13.65px / 500 / System
    hover: background-position -156px -144px → -104px -144px (icon backdrop tile, span.service_icon::before, in its sprite)
    pressed: background-position -156px -144px → -104px -144px (icon backdrop tile, span.service_icon::before, in its sprite)
    states: 'default captured 2026-07-11 (11 shortcuts, each 64 x 68); on 2026-09-29, with :hover and :active matched, hover and pressed move the icon''s 50 x 50 backdrop tile (span.service_icon::before) in its sprite sheet (sp_main.38ce5a51, 484 x 476) from background-position -156px -144px to -104px -144px, on 뉴스 and on 메일, while the glyph (::after) and the label stay; pixels were not diffed, so how the tile looks is not stated; the state probe does not compare background-position, so the value comes from a separate sprite check (corrected 2026-09-29: earlier text said the icon and label stayed at rest); keyboard focus does not move the tile and draws only the browser default ring (outline auto); font is the label (span.service_name), not the anchor (14.7px / 500)'
    use: 'Portal-home header service shortcut (a.link_service: icon plus label, e.g. 뉴스)'
  subscribe-pill:
    type: button
    backgroundColor: transparent
    textColor: '#406cdc'
    border: '1px solid #e0ecff'
    rounded: 13px
    padding: 0px 5px 0px 7px
    height: 26px
    typography: 12.6px / 800 / System
    states: default captured 2026-07-11 on four items of the news tab (tab interaction captures); no pointer-state sample
    use: Portal-home press subscribe button in the news media tab (btn_subscribe, two characters); tracking -0.4px
  corporate-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#1a1d24'
    height: 26px
    typography: 16px / 400 / InterVariable
    hover: font-weight 600
    pressed: font-weight 600
    states: 'default, hover and pressed sampled 2026-07-11 on eight sibling links of the brand-resource page (surface-3 captures 1 to 8): weight 400 to 600 while the colour stays #1a1d24; focus not sampled (the 2026-09-29 probe covered the portal only)'
    use: NAVER Corp site header navigation link (a.nav__link) on the brand-resource page; tracking -0.5px
  serp-share-button:
    type: button
    backgroundColor: transparent
    textColor: '#8c8c8c'
    padding: 6px 6px 14px
    height: 41px
    typography: 13px / 400 / System
    hover: 'fg #595959'
    pressed: 'fg #595959'
    states: 'default, hover and pressed sampled 2026-07-11 (surface-2::[data-omd-capture="17"]): fg #8c8c8c to #595959, the hover colour of the ten vertical tabs beside it; focus not sampled'
    use: Search-results share control at the end of the vertical-tab row (a.bt_share, role=button); tracking -0.3px
fonts:
  roles:
    portal: System
    corporate: InterVariable
---

# Naver

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Naver; reproduced for educational reference. Full prose: https://oh-my-design.kr/naver/design.md
