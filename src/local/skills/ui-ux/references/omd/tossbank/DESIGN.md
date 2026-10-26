---
name: Toss Bank
colors:
  brand: '#0064ff'
  brand-gray: '#202632'
  primary: '#3182f6'
  canvas: '#ffffff'
  foreground: '#212529'
  foreground-strong: '#191f28'
  foreground-secondary: '#4e5968'
  muted: '#6b7684'
  hairline: '#e5e8eb'
  border: '#d1d6db'
  surface-muted: '#f2f4f6'
typography:
  marketing-title:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.3
    use: One observed marketing-home heading; not an app display scale.
  navigation:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.5
    use: Observed public-site navigation control text.
  docs-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed product-disclosure and protected-products content text.
  docs-utility:
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.6
    use: Observed compact documentation control text.
rounded:
  none: 0px
  compact: 20px
  pill: 40px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 32
components:
  docs-outline-button:
    type: button
    textColor: '#4e5968'
    border: '1px solid #4e5968'
    rounded: 40px
    padding: 4px 10px
    typography: 11/600 Toss Product Sans
    hover: bg rgba(217,217,255,0.11)
    pressed: bg rgba(217,217,255,0.11)
    focus: bg rgba(217,217,255,0.11); no outline, so the faint tint is the only focus signal — measured 2026-09-29
    states: default captured 2026-07-12 on product-disclosure and protected-products, with July state frames reading the same tint; hover, pressed and keyboard focus measured 2026-09-29 on product-disclosure in two separate loads (Tab 12), identical values; transition all 0s
    use: Observed default documentation-chrome button on the two customer-information routes only.
  docs-tab:
    type: tab
    textColor: rgba(2,9,19,0.91)
    padding: 9px 14px
    typography: 16/400 Toss Product Sans (the button's computed style; the visible label span's size and weight were not read)
    selected: bg rgba(2,32,71,0.05) on a child span filling the tab (174.9px x 40px); the button stays transparent
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    focus: 'no visible indication: no change on the tab, its ::before/::after, 4 descendants or 3 ancestor levels, border included (fixed probe tool after Tab 13) — measured 2026-09-29'
    states: Selected tab (aria-selected=true) captured 2026-07-12; hover and pressed measured 2026-09-29 (tool and cross-check); keyboard focus reached by Tab 13 although tabIndex reads -1, read first by a cross-check script and then by the fixed probe tool with border compared; the other tab was not measured
    use: Observed selected documentation tab at product-disclosure only.
  pill-action:
    type: button
    backgroundColor: rgba(253,253,254,0.89)
    textColor: '#191f28'
    rounded: 100px
    padding: 18px 32px
    height: 63px
    typography: '17px / 700 / Toss Product Sans (label span; the button computes #212529 16px / 400)'
    hover: 'bg #ffffff'
    pressed: 'bg #ffffff'
    focus: 'no visible indication: outline none and no other compared property changes (measured 2026-09-29)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 (Tab 13); only the fill alpha changes; transition background 0.15s ease-in
    use: Home hero pill action 자세히 보기 on the dark hero; marketing evidence only
  article-card:
    type: card
    backgroundColor: transparent
    textColor: '#e5e8eb'
    rounded: 20px
    padding: 0px 0px 32px
    size: 319px x 348px
    hover: 'transform translateY(-8px); overlay gradient rgba(255,255,255,0.4) / rgba(209,209,253,0.05) → rgba(255,255,255,0.3) / rgba(217,217,255,0.11); title fg #e5e8eb → #3182f6'
    pressed: 'same as hover: transform translateY(-8px), overlay gradient to rgba(217,217,255,0.11), title fg #3182f6'
    focus: 'no visible indication: outline none and no other compared property changes (measured 2026-09-29)'
    states: default captured 2026-07-12 (24 cards); hover, pressed and keyboard focus measured 2026-09-29 on the first card (Tab 14); box-shadow stays none; transition transform 0.15s ease-in, background 0.3s ease-out
    use: Home article card (link to /articles/…); fg is the title text
  nav-menu:
    type: tab
    backgroundColor: transparent
    textColor: rgba(253,253,254,0.89)
    padding: 12px 0px
    typography: 15px / 500 / Toss Product Sans
    hover: 'fg #3182f6'
    pressed: 'fg #3182f6'
    focus: 'no visible indication: outline none and no other compared property changes (measured 2026-09-29)'
    states: 'default, hover and pressed captured 2026-07-12 on home (9 buttons, all #3182f6) and on the documentation routes, where the buttons rest at #4e5968; re-measured 2026-09-29 on 은행소개; keyboard focus measured 2026-09-29 (Tab 3); the July focus frames were read with the pointer still over the control'
    use: Global header menu button (은행소개, 통장, 예금・적금 …) over the dark home hero
  docs-link:
    type: tab
    backgroundColor: transparent
    textColor: '#3182f6'
    padding: 0px 7px 0px 0px
    typography: 15px / 400 / Toss Product Sans
    hover: 'fg #0056b3'
    pressed: 'fg #0056b3'
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: default captured 2026-07-12 (nine links); hover, pressed and keyboard focus measured 2026-09-29 in two loads (Tab 14)
    use: Product-disclosure regulator link (금융감독원 금융소비자정보포털시스템 …)
  home-outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#d1d6db'
    border: '1px solid #e5e8eb'
    rounded: 40px
    padding: 4px 10px
    height: 28px
    typography: 11px / 600 / Toss Product Sans
    hover: bg rgba(217,217,255,0.11)
    pressed: bg rgba(217,217,255,0.11)
    states: default, hover and pressed captured 2026-07-12 (one button; both frames equal the tint measured on docs-outline-button); not state-read on 2026-09-29; keyboard focus not measured
    use: 'Home header 시작하기 over the dark hero: the same control as docs-outline-button in the home colour context'
  carousel-arrow:
    type: button
    backgroundColor: rgba(222,222,255,0.19)
    rounded: 50%
    padding: 10px
    size: 64px x 64px
    states: default captured 2026-07-12 (two arrows); the 2026-09-29 probe survey lists the same arrows with tabIndex -1; no state was read
    use: Home hero carousel previous and next arrow (div role=button, outside the Tab order)
  category-tag:
    type: badge
    backgroundColor: transparent
    textColor: '#b0b8c1'
    typography: 12px / 500 / Toss Product Sans
    states: default captured 2026-07-12 (24, one per article card) and read again 2026-09-29 as the article card label span; no state sample
    use: Article-card category tag (span role=button, e.g. 일상)
  submenu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#191f28'
    padding: 12px 0px
    height: 48px
    typography: 16px / 700 / Toss Product Sans
    states: 'default captured 2026-07-12 (24 on the documentation routes; on home the same links read #d1d6db); no state sample'
    use: Header mega-menu product link (nav-pc-submenu), in the DOM before the menu opens
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#6b7684'
    typography: 13px / 400 / Toss Product Sans
    states: default captured 2026-07-12 (18 on the documentation routes; the home footer sets the same colour at 11px / 400); no state sample
    use: Footer link
  data-table:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#6b7684'
    border: '1px solid #d1d6db'
    height: 41px
    typography: 14px / 500 / Toss Product Sans
    states: default captured 2026-07-12 (168 body cells, 7 header cells); no state sample
    use: 'Protected-products table: header cells bg #f2f4f6 with #4e5968 text, body cells #ffffff with #6b7684 text, 1px #d1d6db grid, 41px rows'
fonts:
  roles:
    sans: Toss Product Sans
---

# Toss Bank

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Toss Bank; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/tossbank/DESIGN.md
