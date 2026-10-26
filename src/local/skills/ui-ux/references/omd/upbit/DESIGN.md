---
name: Upbit
colors:
  accent: '#0062df'
  accent-deep: '#003597'
  rise: '#dd3c44'
  fall: '#1375ec'
  ink: '#1a2434'
  body: '#333333'
  muted: '#565d6a'
  border: '#d6d8db'
  surface: '#ffffff'
  canvas: '#e9ecf1'
  control: '#f4f5f7'
  disabled: '#8e929b'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 21px
    use: Observed public home/list body text
  dense:
    fontSize: 12px
    fontWeight: 400
    use: Observed exchange labels and quick-fill control text
rounded:
  square: 0px
  control: 4px
spacing:
  control-inline: 8
components:
  quick-fill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a2434'
    border: '1px solid #d6d8db'
    rounded: 4px
    padding: 0px 8px 1px
    height: 28px
    typography: 12px / 400
    states: default captured; the capture holds no state frame for this element
    use: Exchange percentage quick-fill link; surface-2::[data-omd-capture="139"]
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  home-header-link:
    type: tab
    backgroundColor: transparent
    textColor: '#1a2434'
    rounded: 0px
    padding: 0px
    height: 22px
    typography: 15px / 400 / 22px
    hover: font 15px / 500
    pressed: font 15px / 500
    states: 'rest, hover, and pressed sampled on the home header links (capture 1-5; 1-4 carry text, 5 is an 84 x 24 link without text). Every hover and pressed frame records weight 500 against rest 400, and weight is the only dumped property that moves; the siblings agree. Focus is not declared from the bundle: the collector presses before it focuses, which suppresses :focus-visible'
    use: Public home header navigation link (a.css-h3yhvr) at home::[data-omd-capture="1"]
  dark-header-link:
    type: tab
    backgroundColor: transparent
    textColor: rgba(255, 255, 255, 0.6)
    rounded: 0px
    padding: 0px
    height: 22px
    typography: 15px / 400 / 22px
    hover: font 15px / 500
    pressed: font 15px / 500
    states: 'same class as the home header link; rest, hover, and pressed sampled on the exchange header (capture 2-5) and the notice header (surface-3 capture 1-5). Every hover and pressed frame records weight 500 against rest 400, the only dumped property that moves; the siblings agree. Focus is not declared from the bundle: the collector presses before it focuses, which suppresses :focus-visible'
    use: Exchange and service-centre header navigation link (a.css-h3yhvr) at surface-2::[data-omd-capture="2"]; white at 60% alpha implies a dark header bar, whose fill was not sampled on this element
  exchange-panel-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#333333'
    border: '0px 0px 1px #dddddd'
    rounded: 0px
    padding: 0px
    height: 45px
    typography: 16px / 500 / 45px
    selected: 'fg #0062df, border 0px 0px 3px #0062df, 16px / 700'
    states: rest (capture 16) and the active tab (capture 15, class tab__item__link--active) captured; the capture holds no pointer-state frame for either
    use: Exchange panel tab (a.tab__item__link) at surface-2::[data-omd-capture="16"]; the border is bottom-only
  order-side-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#333333'
    border: '0px 0px 1px #d4d6dc'
    rounded: 0px
    padding: 0px
    height: 45px
    typography: 16px / 500 / 42px
    selected: 'fg #dd3c44, border 0px 0px 3px #dd3c44, 16px / 700'
    states: rest (capture 132) and the selected buy side (capture 131, inside li.tabB__buy.on) captured; only the buy side was captured selected, so no selected colour is recorded for the other side; no pointer-state frame
    use: Exchange order-form side tab (a.tabB__button) at surface-2::[data-omd-capture="132"]; the border is bottom-only
  notice-page-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a2434'
    border: '1px #d6d8db'
    rounded: 0px
    padding: 0px
    size: 28px x 28px
    typography: 12px / 400
    selected: 'bg #0062df, fg #ffffff, border 1px #0062df'
    states: rest on the page buttons (button.css-10yd3aw, 11 occurrences) and the current page (capture 48, button.css-1arrn0x) captured; no pointer-state frame
    use: Service-centre notice pagination button at surface-3::[data-omd-capture="49"]
  notice-search-input:
    type: input
    backgroundColor: transparent
    textColor: '#1a2434'
    rounded: 0px
    padding: 0px
    height: 42px
    typography: 14px / 400 / Arial
    states: default captured; no state frame
    use: Service-centre notice search field (input.css-1sxigs) at surface-3::[data-omd-capture="24"]; transparent and borderless, its wrapper was not sampled, and it resolves to the system family Arial rather than the Roboto stack
  order-form-input:
    type: input
    backgroundColor: transparent
    textColor: '#1a2434'
    rounded: 0px
    padding: 0px
    height: 38px
    typography: 14px / 400 / Arial
    states: default captured; no state frame
    use: Exchange order-form text field (input[type=text].css-1r6ulzr, three occurrences) at surface-2::[data-omd-capture="135"]; transparent and borderless, its wrapper was not sampled, and it resolves to the system family Arial
  notice-panel:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: 60px 45px 45px
    shadow: rgb(222, 225, 231) 2px 2px 4px 0px
    states: non-interactive container
    use: Service-centre notice panel (article.css-mzy1sz) at surface-3::article
  exchange-panel:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: 0px
    shadow: none
    states: non-interactive container
    use: Exchange white data panel (article) at surface-2::article; six article panels, 400 to 990px wide, compute the same fill, radius, padding, and shadow
---

# Upbit

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Upbit; reproduced for educational reference. Full prose: https://oh-my-design.kr/upbit/design.md
