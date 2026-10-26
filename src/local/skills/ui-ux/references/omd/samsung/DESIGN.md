---
name: Samsung
colors:
  primary: '#000000'
  canvas: '#ffffff'
  surface: '#f7f7f7'
  foreground: '#000000'
  muted: '#707070'
  border: '#dddddd'
  carousel-arrow: '#007aff'
  one-ui-primary: '#0381fe'
  gnb-active: '#006bea'
typography:
  display:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 32
    use: Observed product-card heading on the AI products surface
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 21.2798
    use: Observed product-card body on the AI products surface
  action:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 19
    use: Observed contained CTA label on the Samsung Korea homepage
rounded:
  sharp: 0px
  pill: 20px
  chip: 40px
spacing:
  nav-inline: 12
  action-inline: 24
  card-inset: 32
components:
  ai-product-tabs:
    type: tab
    textColor: '#000000'
    rounded: 0px
    padding: 4px 0px
    typography: 18px/700 SamsungOneKorean
    states: selected / tab-selected observed
    use: AI products `tab__item-title`; selector surface-2::[data-omd-capture="25"]
  contained-cta:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    border: '1px solid #000000'
    rounded: 20px
    padding: 10px 24px 9px
    height: 40px
    typography: 14px / 700 / SamsungOneKorean
    focus: 'outline 2px dotted #000000'
    states: 'default captured 2026-07-13 (36 homepage occurrences); on 2026-09-29 hover and pressed matched :hover and :active and left fill, border and label at rest (transition: all 0s), so no hover or pressed value is declared; the probed first instance sits in a product tile''s 구매하기 row, which stays at opacity 0 until the tile is hovered, pressed or focused (see product-tile), so its visibility is the tile''s reveal, not a state of the pill; keyboard focus (Tab, :focus-visible matched) draws an authored 2px dotted #000000 outline at 0px offset'
    use: Samsung Korea homepage contained CTA (button.cta.cta-ntrns-fild, 구매하기)
  outlined-cta:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #000000'
    rounded: 20px
    padding: 10px 24px 9px
    height: 40px
    typography: 14px / 700 / SamsungOneKorean
    hover: 'bg #000000, fg #ffffff'
    pressed: 'bg #000000, fg #ffffff'
    focus: 'outline 2px dotted #000000'
    states: 'default captured 2026-07-13 (six homepage occurrences); hover and pressed measured 2026-09-29 with :hover and :active matched: the button inverts to bg #000000 and fg #ffffff (transition: background-color, border-color, color 0.2s linear, read after it ended); keyboard focus draws an authored 2px dotted #000000 outline at 0px offset and keeps the transparent fill'
    use: Samsung Korea homepage outlined CTA (button.cta.cta-outl)
  underlined-cta:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    padding: 0px 0px 2px
    height: 21px
    typography: 14px / 700 / SamsungOneKorean
    pressed: fg rgba(0, 0, 0, 0.7)
    focus: 'outline 2px dotted #000000, 1px offset'
    states: 'default captured 2026-07-13; the underline is a 1px #000000 ::after bar, not text-decoration; pressed fg rgba(0, 0, 0, 0.7) in the 2026-07-13 capture (home::[data-omd-capture="23"]::state-pressed) and again on 2026-09-29 with :active matched, while the bar stays #000000; hover matched :hover on 2026-09-29 and left every compared property at rest, so no hover value is declared; keyboard focus draws an authored 2px dotted #000000 outline at 1px offset'
    use: Samsung Korea homepage text CTA (a.cta.cta-undr, 더 알아보기)
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    padding: 14px 12px
    height: 47px
    typography: 16px / 700 / SamsungOneKorean
    hover: 'fg #006bea, 2px #006bea bar via ::before'
    pressed: 'fg #006bea, 2px #006bea bar via ::before'
    focus: 'fg #006bea, 2px #006bea bar, outline 2px dotted #000000 at 1px offset'
    states: 'default captured 2026-07-13 on all three surfaces; pressed fg #006bea on every sampled navigation link in that capture (11 main and 3 utility links on each surface; hover was not sampled then); hover and pressed measured 2026-09-29 with :hover and :active matched: fg #006bea and a 2px #006bea ::before bar going from opacity 0 to 1, and they also open the white mega-menu panel (an ancestor pseudo, the menu list''s ::after, from 1440 x 0 at opacity 0 to 1440 x 406 at opacity 1); keyboard focus (Tab stop 5) shows the same blue text and bar plus an authored 2px dotted #000000 outline at 1px offset and does not open the panel; the blue text and bar stayed after focus moved to the next item, which suggests a script-applied current-item state (a lead, not a finding)'
    use: Samsung Korea global navigation link (a.nv00-gnb-v4__l0-menu-link, e.g. 모바일)
  search-trigger:
    type: button
    backgroundColor: '#f7f7f7'
    border: '1px solid #f7f7f7'
    rounded: 40px
    padding: 9px
    size: 36px x 36px
    hover: bg rgba(247, 247, 247, 0.3), border 1px rgba(0, 0, 0, 0.3)
    pressed: bg rgba(247, 247, 247, 0.3), border 1px rgba(0, 0, 0, 0.3)
    focus: 'outline 2px dotted #000000'
    states: 'rest as read on the homepage with the header scrolled (2026-09-29) and as captured 2026-07-13 on the AI-products and brand-identity pages; at the homepage page top the same button reads bg rgba(247, 247, 247, 0.3) with a 1px rgba(0, 0, 0, 0.2) border; hover and pressed measured 2026-09-29 on the scrolled header with :hover and :active matched (border-color transition 0.5s, read after it ended), and the inner keyword text turns from #757575 to #000000; keyboard focus draws an authored 2px dotted #000000 outline at 0px offset; the 2026-07-13 pressed frames on the AI-products and brand-identity pages kept bg #f7f7f7, so no pressed value is asserted for those pages'
    use: Samsung Korea header search trigger (button.search__btn); the search input opens in a fixed layer behind a click and was not measured
  product-tile:
    type: card
    backgroundColor: transparent
    textColor: '#000000'
    size: 342px x 342px
    typography: 24px / 700
    hover: image scale(1.05); opacity 0→1 on the 구매하기 CTA row
    pressed: image scale(1.05); opacity 0→1 on the 구매하기 CTA row
    focus: 'outline 2px dotted #000000 at 1px offset; image scale(1.05); opacity 0→1 on the 구매하기 CTA row'
    states: 'default captured 2026-07-13 (home captures 25, 27 and 29, each 342 x 342); hover, pressed and keyboard focus measured 2026-09-29 with :hover, :active and :focus-visible matched: the tile image scales to 1.05 and the tile''s 구매하기 CTA row (div.cta-line, 366 x 40) fades from opacity 0 to 1, so the contained CTA inside it stays invisible until the tile is hovered or focused; nothing recolours; focus adds an authored 2px dotted #000000 outline at 1px offset; fg and font are the h2 title label, not the anchor (16px / 400 / SamsungOneKorean)'
    use: Samsung Korea homepage product tile link (a.clickable, e.g. Galaxy S26 Ultra)
  product-media-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 20px
    size: 330px x 330px
    states: default captured 2026-07-13 (12 occurrences on the AI-products page; a 684px-square variant also occurs); no pointer-state sample
    use: AI-products media wrapper (div.showcase-card-tab-card__img-wrap); not a general commerce-card template
  white-contained-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 20px
    padding: 10px 24px 11px
    height: 40px
    typography: 14px / 700 / SamsungOneKorean
    states: default captured 2026-07-13 on four brand-identity CTAs; no pointer-state sample
    use: Brand-identity page white contained CTA (a.cta.cta--contained.cta--white), tracking -0.28px
  icon-label-cta:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 10px 0px 11px
    height: 40px
    typography: 14px / 700 / SamsungOneKorean
    states: default captured 2026-07-13 on six AI-products CTAs; no pointer-state sample
    use: AI-products black label CTA with an icon (a.cta.cta--icon.cta--label.cta--black)
  brand-lnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    padding: 0px 32px
    height: 46px
    typography: 14px / 400 / SamsungOneKorean
    states: 'default captured 2026-07-13; one link (surface-3::[data-omd-capture="20"]) has hover, pressed and focus frames at fg #555555, but no sibling link has a state frame and #555555 occurs nowhere at rest, so no state value is declared'
    use: Brand-identity page local navigation link (a.explore-lnb__link), tracking -0.28px
fonts:
  roles:
    display: Samsung Sharp Sans
    ui: SamsungOneKorean
---

# Samsung

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Samsung; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/samsung/DESIGN.md
