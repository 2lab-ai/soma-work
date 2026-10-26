---
name: 11st
colors:
  canvas: '#ffffff'
  foreground: '#111111'
  body: '#666666'
  brand-red: '#ff0038'
  muted: '#a9a9a9'
  hairline: '#eeeeee'
  on-brand: '#ffffff'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Repeated public product-home body, list, button, and dialog samples
  search:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 2.44
    use: Public product-home global search input
  price:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Public home deal-card price using Lato New first
  price-struck:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.85
    use: Public home deal-card struck price using Lato New first
rounded:
  square: 0px
  card: 4px
  billboard-control: 50px
  circular: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 20
components:
  global-search:
    type: input
    backgroundColor: transparent
    textColor: '#666666'
    rounded: 0px
    height: 44px
    typography: 18px / 400 Noto Sans KR
    states: 'pressed samples on home and /main change foreground to #111111; focus not declared (the bundle records its focus frames after a press, so they are not a focus-visible sample); no flow transition inferred'
    use: Product home and /main; selector home::[data-omd-capture=1]
    pressed: '#111111'
  billboard-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#999999'
    border: '1px solid #eeeeee'
    rounded: 50px
    height: 50px
    typography: 17px / 400 Noto Sans KR
    states: default only; no interaction transition captured
    use: Product home and /main billboard control; selector home::[data-omd-capture=109]
  deal-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 4px
    typography: 15px / 400 Noto Sans KR
    shadow: rgba(0,0,0,0.06) 0px 2px 10px -2px, rgba(0,0,0,0.28) 0px 0px 1px
    states: default only; hover not sampled. Text colour and font are the card name line (div.c-card-item__name, line height 22.5px), corrected 2026-09-30
    use: Home deal card; selector home::div.c-card-item.c-card-item--deal.c-card-item--box
  header-inventory-dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#666666'
    rounded: 0px
    states: dialog-open observed after the menu trigger on home and /main
    use: Header inventory dialog; selector home::[data-omd-interaction-capture=dialog-0-0]
  gnb-category-link:
    type: tab
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 0px
    padding: 0px
    height: 66px
    typography: 17px / 700 11StreetGothic
    states: rest captured on home and /main (captures 12-18 on each route); no state frame in the bundle
    use: Header category link set in the brand face, home::[data-omd-capture="12"]; line height 66px, the height of the row
  gnb-side-link:
    type: tab
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 0px
    padding: 0px
    height: 21px
    typography: 14px / 400 Noto Sans KR
    states: rest captured on home and /main (captures 19 and 20 on each route); no state frame in the bundle
    use: Header link to the right of the category links, home::[data-omd-capture="19"]; line height 21px; its list item (class line) adds 14px left padding
  header-list-link:
    type: button
    backgroundColor: transparent
    textColor: '#666666'
    rounded: 0px
    padding: 0px
    height: 24px
    typography: 14px / 400 Noto Sans KR
    hover: 'fg #ff0038'
    pressed: 'fg #ff0038'
    states: 'rest on four links (captures 3 and 4 on home and /main); hover and pressed sampled on three of them (6 frames), each recording colour #666666 to #ff0038 and nothing else; focus not sampled'
    use: Header text link, 147 px wide, in the two-row list between the search button (capture 2) and the button with class raking_button (capture 5), home::[data-omd-capture="3"]; line height 21px
  icon-text-tile:
    type: card
    backgroundColor: '#ffffff'
    rounded: 27px
    padding: 90px 0px 0px
    size: 166px x 103px
    states: six captured at rest on home (captures 117-122); no state frame in the bundle
    use: Home icon-and-text shortcut tile (a.c-icontext), home::[data-omd-capture="117"]. The anchor computes font-size 0px, so its label sits in a child outside the dump and no label style is declared. The more tile (button.c-icontext--more, capture 123) shares the background, radius and padding at 166 x 126
  wing-top-button:
    type: button
    backgroundColor: '#000000'
    rounded: 50%
    size: 60px x 60px
    states: one captured at rest on /main; no state frame in the bundle
    use: Circular button with class c_wing_top on /main, surface-2::[data-omd-capture="120"]; its label text is visually hidden (line height 200px), so no label style is declared
  footer-menu-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 14px / 400 Noto Sans KR
    states: nine captured at rest on /main (captures 121-129); no state frame in the bundle
    use: Footer menu link (a.lk_f_menu) on /main, surface-2::[data-omd-capture="121"]; line height 21px
  footer-outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    border: '1px #cccccc'
    rounded: 0px
    padding: 0px 35px 0px 10px
    height: 36px
    typography: 14px / 400 Noto Sans KR
    states: two captured at rest on /main (captures 130 and 131, both 175 px wide); no state frame in the bundle
    use: Footer outlined button on /main, surface-2::[data-omd-capture="130"]; line height 21px
  footer-bordered-link:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    border: '1px #eeeeee'
    rounded: 0px
    padding: 0px 6px
    height: 24px
    typography: 12px / 400 Noto Sans KR
    states: two captured at rest on /main (captures 133 and 134); no state frame in the bundle
    use: Small bordered footer link on /main, surface-2::[data-omd-capture="133"]; line height 22px
  footer-contact-button:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 14px / 700 Noto Sans KR
    states: one captured at rest on /main; no state frame in the bundle
    use: Bold footer text button (button.c-footer-contact__button) on /main, surface-2::[data-omd-capture="135"]; line height 20px
fonts:
  roles:
    ui: Noto Sans KR
    numerals: Lato New
    brand: 11StreetGothic
---

# 11st

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 11st; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/11st/DESIGN.md
