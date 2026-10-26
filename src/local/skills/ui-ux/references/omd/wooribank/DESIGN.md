---
name: Woori Bank
colors:
  brand-deep-blue: '#0067ac'
  brand-light-blue: '#20c4f4'
  brand-blue: '#0083ca'
  canvas: '#ffffff'
  foreground: '#000000'
  foreground-secondary: '#333333'
  muted: '#7f7f7f'
typography:
  public-home-title:
    fontSize: 24px
    fontWeight: 700
    use: Observed only on the public home h1; its computed NotoSans declaration has no loaded-FontFace corroboration.
  legacy-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: '-1px'
    use: Observed on repeated text/list samples of the two supplied legacy public service routes.
rounded:
  none: 0px
  home-login-utility: 5px
spacing:
  popup-inline-start: 3
  popup-inline-end: 7
components:
  legacy-information-text-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 0px
    padding: 2px 3px 3px
    height: 26px
    typography: 13px / 400 / 19px / computed stack beginning 맑은 고딕
    states: rest on four inputs (surface-3 capture 35-38); the bundle holds no state frame for any Woori Bank element
    use: Native text input at legacy-information::[data-omd-capture="35"] on the supplied public information route.
  legacy-gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 38px
    typography: 15px / 700 / 40px / computed stack beginning 맑은 고딕, tracking -1px
    selected: 'bg #ffffff, fg #008a44, border 2px #008a44 on the top edge, line-height 37px, 40px high'
    states: rest on nine legacy-service links (capture 12, 14-21) and six legacy-information links (capture 12-17); the link in li.current (legacy-service capture 13) differs from them and is recorded as selected; no state frame
    use: Legacy top navigation link (a.level1-item-a-N) at legacy-service::[data-omd-capture="12"], 92px x 38px; white labels on a bar whose fill sits on an ancestor the capture did not sample
  legacy-all-menu-button:
    type: button
    backgroundColor: '#005329'
    textColor: '#ffffff'
    padding: 10px 12px
    size: 50px x 40px
    typography: 15px / 700 / 40px / computed stack beginning 맑은 고딕, tracking -1px
    states: rest; no state frame
    use: Last item of the legacy-service navigation (a.btn-all.btn-popup.site-menu; an a element with no button role) at legacy-service::[data-omd-capture="22"]
    rounded: 0px
    height: 40px
    pressed: 'bg #37cb4d, border #000000, text-decoration underline (:hover + :active)'
    focus: 'bg #37cb4d, border #000000, text-decoration underline, browser default focus ring (outline auto) on :focus-visible'
  legacy-content-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px #cbcbcb on the parent li'
    padding: 10px 0px
    height: 38px
    typography: 14px / 700 / 18px / computed stack beginning 맑은 고딕, tracking -1px
    selected: 'fg #ffffff, padding 10px 17px; parent li border 1px #4fa528 top and bottom, 1px #cbcbcb sides; the li records a transparent background colour, so the fill behind the white label is not in the capture'
    states: rest on one tab (capture 37); the tab in li.on (capture 36) differs from it and is recorded as selected; no state frame
    use: Legacy content tab (a.js-tab-header.ui-tab-selector) in div.tab1.js-tab at legacy-service::[data-omd-capture="37"]; each parent li is 231px x 37px
  legacy-quick-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    padding: 50px 0px 0px
    size: 105px x 68px
    typography: 14px / 400 / 18px / computed stack beginning 맑은 고딕, tracking -2px
    states: 'rest on eight links per legacy route (legacy-service capture 27-34; legacy-information capture 21-28, where the label is #000000); no state frame'
    use: Legacy quick-menu link (a.q1 to a.q8; no button role) at legacy-service::[data-omd-capture="27"]; the label sits below 50px of top padding
  legacy-information-select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px #d1d1d1'
    rounded: 0px
    padding: 2px 2px 2px 0px
    size: 164px x 25px
    typography: 13px / 400 / normal / computed stack beginning 맑은 고딕
    states: rest; no state frame
    use: Native select (select.sel) at legacy-information::[data-omd-capture="34"], above the four text inputs
  legacy-layer-header:
    type: dialog
    backgroundColor: '#20509f'
    textColor: '#ffffff'
    padding: 0px 0px 0px 26px
    size: 600px x 58px
    typography: 22px / 700 / 53px / computed stack beginning 맑은 고딕, tracking -1px
    states: open in the legacy-information capture; no state frame
    use: Header (h1.ly-header, which holds its own text) of a 600px-wide layer on the legacy-information route; its close link (a.close-layer.lonSaleCloseInfoPop-close, capture 53) is 29px x 29px
  footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#7f7f7f'
    height: 20px
    typography: 12px / 400 / 20px
    states: rest on ten links per route (home capture 69-71, 74-80); no state frame
    use: 'Footer link (a; no button role) on all three routes at home::[data-omd-capture="69"]; two per route are #555555 at 700 (class font-bold font-c-5; home capture 72, 73); NotoSans stack on the home, stack beginning 맑은 고딕 on the legacy routes'
  footer-divided-link:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px #dddddd on the right edge'
    padding: 0px 30px 0px 0px
    height: 14px
    typography: 12px / 400 / 14px
    states: rest on four links per route (home capture 59-62); no state frame
    use: Footer link row (a.js-display-hover-trigger; no button role) on all three routes at home::[data-omd-capture="59"]; the last link (capture 62) has no divider
  home-login-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 5px
    size: 80px x 30px
    typography: 15px / 700 / 15px / NotoSans stack, tracking -1px
    states: rest; no state frame
    use: Home login utility (a.gnb-member-bt.renew_login; no button role) at home::[data-omd-capture="0"], the element behind the 5px home-login-utility radius; it records a transparent background and no border, so the corner shapes no measured fill or outline
  home-gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    height: 15px
    typography: 15px / 700 / 15px / NotoSans stack
    states: rest on ten header links (home capture 2-11), some icon-only (textLength 0); no state frame
    use: Home header link (a) at home::[data-omd-capture="2"]
  home-quick-tile:
    type: button
    backgroundColor: '#0082cd'
    textColor: '#ffffff'
    padding: 12px 42px 12px 48px
    size: 170px x 77px
    typography: 20px / 700 / 26px / NotoSans stack
    states: rest; no state frame
    use: 'Home quick-band link (a; no button role) at home::[data-omd-capture="21"]; the same 76px row holds three links with #ffffff 22px / 700 / 28px labels on a transparent fill (capture 22-24; the fill behind them is not in the capture) and a #ffffff li.q_btn tile whose link has a #000000 22px / 700 / 28px label (capture 25); #0082cd is a web fill, not the CI blue #0083ca'
  home-product-card:
    type: card
    border: '1px #d8d8d8'
    rounded: 0px
    size: 306px x 300px
    use: 'Home product card (li), three in a row, each with a #666666 14px / 400 description (p.font-14.font-c-6); its own #000000 12px / 400 is inherited page text, so no label style is claimed'
---

# Woori Bank

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Woori Bank; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/wooribank/DESIGN.md
