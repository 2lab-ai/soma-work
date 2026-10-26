---
name: Coinone
colors:
  brand: '#006BD6'
  point: '#0090FF'
  brand-deep: '#194386'
  brand-navy: '#062554'
  canvas: '#FFFFFF'
  foreground: '#17181B'
  product-primary: '#0B59D5'
  control-border: '#DDE4EB'
  login-text: '#79818F'
typography:
  home-control:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.38
    use: Home compact control, selector home::[data-omd-capture=59]
  trading-tab:
    fontSize: 13px
    fontWeight: 400
    use: Trading chart tab, selector surface-2::[data-omd-capture=49]
rounded:
  login: 3px
  control: 6px
  badge: 26px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
components:
  sign-in-outline:
    type: button
    textColor: '#79818F'
    border: '1px solid #AEB3BB'
    rounded: 3px
    padding: 0px 8px
    height: 24px
    typography: 12px / 400 pretendardCoinone
    hover: rgba(121, 129, 143, 0.05)
    states: default measured in the 2026-07-13 bundle; the hover value comes from a 2026-09-16 live CSS inspection (claim method live-css-inspect) and is not in the bundle, which holds no state frame for this element
    use: Home sign-in control, selector home::[data-omd-capture=14]
  home-compact-control:
    type: button
    backgroundColor: '#FFFFFF'
    textColor: '#040505'
    border: '1px solid #DDE4EB'
    rounded: 6px
    padding: 6px 12px
    height: 32px
    typography: 13px / 500 pretendardCoinone
    hover: rgba(61, 80, 137, 0.1)
    pressed: rgba(61, 80, 137, 0.1)
    states: 'default measured in the 2026-07-13 bundle; the hover and pressed values come from a 2026-09-16 live CSS inspection (claim method live-css-inspect) and are not in the bundle, which holds no state frame for this element; a sibling in the same row (capture 58) records border 1px #040505 and 13px / 700 with no aria-selected, so it is described, not declared'
    use: Home compact product control, selector home::[data-omd-capture=59]
  trading-chart-tab:
    type: tab
    textColor: '#18191C'
    padding: 0px 16px
    height: 37px
    typography: 13px / 400 Spoqa Han Sans
    selected: 'bg #ffffff, border 1px #e0e0e0 on top and sides, 13px / 700 (class is-active, capture 48)'
    states: rest captured on capture 49; the tab with class is-active (capture 48) is recorded as selected; no state frame on either
    use: Trading chart tab, selector surface-2::[data-omd-capture=49]
  trading-side-tab:
    type: tab
    textColor: '#9E9E9E'
    height: 40px
    typography: 14px / 400 Spoqa Han Sans
    states: default captured; no state frame for this element
    use: Trading side tab, selector surface-2::[data-omd-capture=156]
  home-gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#18191c'
    rounded: 6px
    padding: 6px 10px
    height: 36px
    typography: 16px / 700 / 24px pretendardCoinone
    hover: bg rgba(23, 114, 248, 0.05)
    pressed: bg rgba(23, 114, 248, 0.05)
    states: rest on seven links (capture 3-9); hover and pressed sampled on all seven, all fourteen frames recording the same value; focus not declared
    use: 'Exchange-home global navigation link (a.gnb-link, letter-spacing 1px) at home::[data-omd-capture="3"]; the tint hue rgb(23, 114, 248) is #1772f8, the rest fill of the trading sign-in button'
  trading-nav-icon-button:
    type: button
    backgroundColor: transparent
    rounded: 4px
    padding: 0px
    size: 24px x 24px
    hover: 'bg #f5f7f9'
    pressed: 'bg #f5f7f9'
    states: 'single element: hover and pressed frames agree exactly, opaque #f5f7f9 over a transparent rest; no focus frame'
    use: Trading-route navigation icon button (button.navigation-icon-wrapper) at surface-2::[data-omd-capture="13"]; it has no text node, so no label colour is claimed; bundle variant 47 uses its hover frame as the representative, which is not a rest value
  home-signup-outline:
    type: button
    backgroundColor: transparent
    textColor: '#1772f8'
    border: '1px #2076f4'
    rounded: 3px
    padding: 0px 8px
    height: 24px
    typography: 12px / 700 pretendardCoinone
    states: default captured; no state frame on this element
    use: Exchange-home sign-up control (button.btn-signup) beside the sign-in control at home::[data-omd-capture="13"], 59 x 24
  home-primary-cta:
    type: button
    backgroundColor: '#0b59d5'
    textColor: '#ffffff'
    border: '1px #0b59d5'
    rounded: 8px
    padding: 14px 18px
    height: 49px
    typography: 15px / 700 / 19px pretendardCoinone
    states: default captured; no state frame on this element
    use: Exchange-home primary call to action at home::[data-omd-capture="15"], 90 x 49; capture 104 records the same fill, radius, padding and type with a 0px border at 186 x 47
    focus: no visible change (measured 2026-10-16) on :focus-visible
  home-secondary-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#040505'
    border: '1px #dde4eb'
    rounded: 8px
    padding: 14px 18px
    height: 49px
    typography: 15px / 500 / 19px pretendardCoinone
    states: default captured; no state frame on this element
    use: Exchange-home secondary call to action beside the primary one at home::[data-omd-capture="16"], 103 x 49
  home-app-download-button:
    type: button
    backgroundColor: '#ebf0f5'
    textColor: '#040505'
    rounded: 10px
    padding: 13px
    height: 48px
    typography: 13px / 700 / 18px pretendardCoinone
    states: default captured on both buttons; no state frame
    use: 'Exchange-home app-download button inside the AppDownloadContainer article at home::[data-omd-capture="106"], 194 x 48; its sibling (capture 107) records the dark variant, bg #040505 with fg #ffffff, same geometry and type'
  home-card:
    type: card
    backgroundColor: '#f4f7f9'
    rounded: 12px
    padding: 20px
    size: 250px x 186px
    states: default captured on fifteen cards; no state frame
    use: Exchange-home card (div, generated class ending -Card) at home::[data-omd-capture="77"]; a container, so its inherited 16px / 400 type is not claimed as a label style
  trading-sign-in-button:
    type: button
    backgroundColor: '#1772f8'
    textColor: '#ffffff'
    rounded: 6px
    padding: 6px 0px
    height: 32px
    typography: 14px / 400 Spoqa Han Sans
    states: default captured; no state frame on this element
    use: Trading-route sign-in button (a.sign-in-button) at surface-2::[data-omd-capture="44"], 120 x 32
  trading-order-button:
    type: button
    backgroundColor: '#e12343'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px
    height: 36px
    typography: 14px / 700 / 16.8px Spoqa Han Sans
    states: default captured; no state frame on this element
    use: Trading-route order button (button.btn-order) at surface-2::[data-omd-capture="160"], 306 x 36
  trading-ticker-tag:
    type: button
    backgroundColor: '#f8f8f9'
    textColor: '#9e9e9e'
    border: 1px transparent
    rounded: 5px
    padding: 5px 8px
    height: 30px
    typography: 12px / 400 Spoqa Han Sans
    states: 'default captured on nine tags (capture 16-24); the first tag (capture 15, extra class trd-tickers-btn-tag) records bg #f5f8ff, fg #1772f8 and border 1px #1772f8, but no aria-selected or active class marks it, so it is described, not declared selected; no state frame'
    use: Trading-route ticker filter tag (button.btn-tag) at surface-2::[data-omd-capture="16"], 40 x 30
  trading-ticker-search:
    type: input
    backgroundColor: transparent
    textColor: '#424242'
    rounded: 0px
    padding: 7px 24px 7px 0px
    size: 299px x 30px
    typography: 14px / 400 Spoqa Han Sans
    states: default captured (classes ng-untouched ng-pristine ng-valid); no focus or error sample
    use: Trading-route ticker search input at surface-2::[data-omd-capture="14"]; its border width is 0px, so no field frame is claimed
  brand-page-lnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#868e96'
    rounded: 0px
    padding: 0px
    height: 21px
    typography: 15px / 400
    hover: 'fg #495057'
    pressed: 'fg #495057'
    states: rest on nine links (capture 9-12, 14-16, 18, 19); hover and pressed sampled on all nine, all eighteen frames recording the same value; no focus frame
    use: Corporate brand-guideline page link (a.lnb-link) near the page foot at surface-3::[data-omd-capture="9"] (coinonecorp.com); documentation chrome, not an exchange product control; its stack leads with Roboto, which the bundle classes as a system family, so no family is claimed
  brand-page-ghost-button:
    type: button
    backgroundColor: transparent
    textColor: '#868e96'
    border: '1px #ced4da'
    rounded: 5px
    padding: 0px 16px
    height: 40px
    typography: 15px / 400
    states: 'default captured; the hover and pressed frames record different partial values (bg alpha 0.027 and 0.137, border #cfd5db and #d3d8de), transition frames, so neither is declared; no focus frame'
    use: Corporate brand-guideline ghost action (a.btn-coinone-ghost2) at surface-3::[data-omd-capture="7"], 153 x 40; documentation chrome, not an exchange product control; its stack leads with Roboto (system family), so no family is claimed
fonts:
  roles:
    home: pretendardCoinone
    trading: Spoqa Han Sans
---

# Coinone

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Coinone; reproduced for educational reference. Full prose: https://oh-my-design.kr/coinone/design.md
