---
name: Coupang
colors:
  canvas: '#ffffff'
  foreground: '#000000'
  foreground-muted: '#555555'
  foreground-secondary: '#333333'
  foreground-account: '#212b36'
  hairline: '#e5e7eb'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed default body text on the live commerce home surface; system-family only.
  search:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed search-field text on the live commerce home surface.
  utility:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.25
    use: Observed compact account and utility text on the live commerce home surface.
  utility-small:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed top utility navigation text on the live commerce home surface.
rounded:
  none: 0px
spacing:
  xxs: 1
  xs: 5
  sm: 10
  md: 12
  lg: 14
  xl: 16
  xxl: 20
  account-gap: 24
components:
  header-menu-item:
    type: listItem
    textColor: '#000000'
    rounded: 0px
    padding: 0px 5px
    use: Observed default header menu list item only.
  header-account-utility:
    type: listItem
    textColor: '#212b36'
    rounded: 0px
    typography: 12/400 system
    use: Observed default account-area list item only.
  header-menu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px
    height: 32px
    typography: 12px / 400 / 32px
    hover: 'fg #4285f4'
    pressed: 'fg #4285f4'
    states: rest on seventeen links (capture 16-32); hover and pressed sampled on eight of them (16-23), all recording the same value; no focus frame
    use: Home header menu link, the text link inside li.gnb-menu-item, at home::[data-omd-capture="16"]
  header-menu-control:
    type: button
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: 0px 16px
    size: 32px x 32px
    states: default captured on both menu buttons (capture 15 and 33; 33 carries the gnb-menu-btn-active class and records the same values); no pointer-state sample
    use: Home header menu button (a.gnb-menu-btn) at home::[data-omd-capture="15"]; it has no text node, so no label colour is claimed
    height: 32px
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  header-search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    size: 351px x 17px
    typography: 14px / 400 / 21px
    states: default captured; no pointer, focus, or error sample
    use: Home header search field (input.headerSearchKeyword) at home::[data-omd-capture="10"]; the input itself has a 0px border, so no field frame is claimed
  search-category-select:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 10px 20px 5px 10px
    height: 37px
    typography: 12px / 400 / 18px
    states: default captured; no pointer-state sample
    use: Header search category selector (a.select--category__current) at home::[data-omd-capture="9"]
  top-utility-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 13px
    typography: 11px / 400 / 16.5px
    states: default captured on six links (capture 2-7); no pointer-state sample
    use: Top utility navigation link at home::[data-omd-capture="2"]; capture 3 through 7 record the same values
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#555555'
    border: 'left 1px #888888'
    rounded: 0px
    padding: 0px 14px
    height: 12px
    typography: 12px / 400 / normal
    states: default captured on thirteen links (capture 60-72); no pointer-state sample
    use: 'Footer link row at home::[data-omd-capture="61"]; every link after the first carries the 1px #888888 left divider (capture 60 has a 0px border); the dump records border width and colour, not border style'
---

# Coupang

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Coupang; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/coupang/DESIGN.md
