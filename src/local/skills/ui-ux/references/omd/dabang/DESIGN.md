---
name: 다방
colors:
  canvas: '#ffffff'
  foreground: '#222222'
  border: '#dfdfdf'
  surface-muted: '#f5f5f5'
  action: '#326cf9'
  map-field-border: '#ededed'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 24px
    use: Repeated public home and map text/control cluster
  section-title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 32px
    use: Public-home section-title sample
  map-control:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 24px
    use: Map location-search and dock-control samples
rounded:
  compact: 2px
  standard: 8px
  map-tool: 6px
  search-entry: 32px
  map-search: 42px
spacing:
  xs: 4
  sm: 8
  md: 16
components:
  header-account-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    padding: 8px 16px
    typography: 16px / 400 Pretendard Variable
    states: 'rest on the header account button on all three routes (capture 4 on home and FAQ, 5 on the map); hover and pressed sampled on all three, all six frames recording bg #f5f5f5; focus not declared. Corrected 2026-09-30: this string read default only while the hover and pressed values were already declared'
    use: Shared public header account control; home::[data-omd-capture=4]
    hover: 'bg #f5f5f5'
    pressed: 'bg #f5f5f5'
  header-outline-action:
    type: button
    textColor: '#222222'
    border: '1px solid #dfdfdf'
    rounded: 2px
    padding: 0px 16px
    typography: 14px / 700 Pretendard Variable
    states: 'rest on six outline actions, two per route (capture 5-6 on home and FAQ, 6-7 on the map); hover and pressed sampled on all six, all twelve frames recording an opaque bg #fcfcfc over the transparent rest; focus not declared. Corrected 2026-09-30: this string read default only while the hover and pressed values were already declared'
    use: Shared public header outline action; home::[data-omd-capture=5]
    hover: 'bg #fcfcfc'
    pressed: 'bg #fcfcfc'
  map-location-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #ededed'
    rounded: 42px
    padding: 7px 37px 7px 15px
    typography: 14px / 400 Pretendard Variable
    states: default captured; its one focus frame moves only the padding (to 7px 37.7506px 7px 19.1284px), a partial value, and no focus state is declared from this capture
    use: Map location-search field; surface-2::[data-omd-capture=1]
  map-dock-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #dfdfdf'
    rounded: 2px
    padding: 0px 7px 0px 11px
    typography: 14px / 400 Pretendard Variable
    states: 'rest on five dock buttons (capture 14-18); hover and pressed sampled on all five and on the icon-only dock button beside them (capture 19), all twelve frames recording bg #ededed; focus not declared. Corrected 2026-09-30: this string read default only while the hover and pressed values were already declared'
    use: Map dock control; surface-2::[data-omd-capture=14]
    hover: 'bg #ededed'
    pressed: 'bg #ededed'
  header-nav-link:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    padding: 8px 16px
    height: 42px
    typography: 16px / 400 / 26px Pretendard Variable
    selected: 'fg #326cf9'
    hover: 'bg #f5f5f5'
    pressed: 'bg #f5f5f5'
    states: 'rest on eight header links (capture 1-3 on home and FAQ, 3-4 on the map); the map-route link with class active (capture 2) records fg #326cf9 where its siblings record #222222, so it is declared selected; hover and pressed sampled on all nine links, all eighteen frames recording bg #f5f5f5; focus not declared'
    use: Shared public header navigation link (a) at home::[data-omd-capture="1"], 60 x 42; same geometry and type as the header account control
  home-filter-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px #dfdfdf'
    rounded: 32px
    padding: 0px 11px
    height: 32px
    typography: 14px / 700 / 24px Pretendard Variable
    states: 'rest on five chips (capture 18-22); the first chip (capture 17) records bg #222222, fg #ffffff and border 1px #222222, but only a generated class separates it, so no selected state is declared; no state frame on any chip'
    use: Public-home pill chip (button) at home::[data-omd-capture="18"], 81 x 32
  home-search-input:
    type: input
    backgroundColor: transparent
    textColor: '#222222'
    padding: 11px 23px 11px 56px
    size: 680px x 48px
    typography: 16px / 400 / 26px Pretendard Variable
    states: default captured; its pressed and focus frames both change only the padding (to 11px 56px), a focus effect, so neither is declared
    use: Public-home search input at home::[data-omd-capture="7"]; its border width is 0px, so no field border is claimed
  home-entry-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #ededed'
    rounded: 12px
    padding: 20px
    size: 333px x 178px
    states: default on five cards (capture 8-12; the second row measures 217 x 172); their pressed frames record only the browser default active-link red on the container, which is not a state value
    use: Public-home card link (a) at home::[data-omd-capture="8"]; a container whose own colour is the browser default link blue, so no label style is claimed
  home-accent-card:
    type: card
    backgroundColor: '#f0f0f0'
    border: '3px #396bf3 on the top edge'
    rounded: 3px
    padding: 33px 20px 30px 30px
    size: 233px x 330px
    states: default on three cards (capture 43-45); no state frame
    use: Public-home card link with a top accent (a) at home::[data-omd-capture="43"]; a container, so its own colour is not claimed as a label style
  map-tool-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 0px
    padding: 6px
    size: 36px x 36px
    typography: 12px / 400 / 20px Pretendard Variable
    hover: 'fg #326cf9, weight 700'
    pressed: 'fg #326cf9, bg #eef8ff, weight 700'
    states: 'rest on the stacked map tool buttons (capture 22-29; the top one has 6px 6px 0px 0px corners, the bottom one 0px 0px 6px 6px, the middle ones 0px); hover and pressed sampled on the top and bottom buttons (capture 22, 23), the two agreeing in each frame; #326cf9 is the rest colour of the selected map links and #eef8ff the selected side-navigation fill; focus not declared'
    use: Map-route tool button stack at surface-2::[data-omd-capture="25"]; captures 22 and 23 have no text node, so their colour is the computed colour an icon can inherit
  map-side-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#434343'
    border: 1px transparent
    rounded: 4px
    padding: 0px
    size: 70px x 64px
    typography: 12px / 500 / 20px Pretendard Variable
    selected: 'bg #eef8ff, fg #326cf9, border 1px #326cf9, 12px / 700'
    states: rest on four links (capture 9-12); the link with class active (capture 8) differs from them and is recorded as selected; their hover, pressed and focus frames record partial values (background alpha 0.024 to 0.067, weights 501 to 513), transition frames, so none is declared
    use: Map-route side navigation link (a) at surface-2::[data-omd-capture="9"]
  map-dark-pill-button:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    border: '1px #222222'
    rounded: 32px
    padding: 0px 16px
    height: 32px
    typography: 14px / 700 / 24px Pretendard Variable
    states: default captured on one element; no state frame
    use: Map-route dark pill button at surface-2::[data-omd-capture="20"], 58 x 32
  footer-app-link:
    type: button
    backgroundColor: '#515151'
    textColor: '#e5e5e5'
    rounded: 2px
    padding: 0px 9px
    height: 30px
    typography: 12px / 400 / 12px Pretendard Variable
    states: default on three links on home (capture 70-72) and three on the FAQ route (capture 22-24); no state frame
    use: Footer link button (a) at home::[data-omd-capture="70"], 112 x 30
  footer-primary-button:
    type: button
    backgroundColor: '#326cf9'
    textColor: '#ffffff'
    rounded: 2px
    padding: 0px 9px
    height: 30px
    typography: 12px / 700 / 20px Pretendard Variable
    states: default on home (capture 73) and the FAQ route (capture 25); no state frame
    use: Footer button at home::[data-omd-capture="73"], 98 x 30
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: 'outline #ededed solid 1px on :focus-visible'
  support-faq-category-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px #ededed'
    rounded: 0px
    size: 394px x 64px
    typography: 16px / 400 / 26px Pretendard Variable
    selected: 'bg #222222, fg #ffffff, border 1px #222222, 16px / 700'
    states: rest on two tabs (capture 8, 9); the tab with class active (capture 7) differs from them and is recorded as selected; no state frame
    use: Support FAQ category tab (a) at surface-3::[data-omd-capture="8"]; support-documentation chrome, not a product token
  support-faq-row:
    type: button
    backgroundColor: transparent
    border: '1px #f5f5f5 on the bottom edge'
    padding: 16px 20px
    size: 1180px x 65px
    states: default on five rows (capture 10-14); no state frame
    use: 'Support FAQ disclosure row (button) at surface-3::[data-omd-capture="10"]; its own #000000 and 13.3333px / 400 are the browser button defaults (the label sits in a child), so no label style is claimed; support-documentation chrome'
fonts:
  roles:
    ui: Pretendard Variable
---

# 다방

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 다방; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/dabang/DESIGN.md
