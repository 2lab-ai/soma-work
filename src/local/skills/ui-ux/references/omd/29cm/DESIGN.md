---
name: 29CM
colors:
  primary: '#000000'
  foreground: '#000000'
  canvas: '#ffffff'
  muted: '#5d5d5d'
  ink-secondary: '#303033'
  ink-tertiary: '#474747'
  accent: '#ff4800'
  border: '#dddddd'
  focus-outline: '#375fff'
typography:
  nav-display:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.5
    use: Desktop editorial navigation
  editorial-title:
    fontSize: 23px
    fontWeight: 600
    lineHeight: 1.3
    use: 29Magazine lead story title
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Shared commerce and editorial body
  product-brand:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.36
    use: Product-grid brand link
  product-name:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.36
    use: Product-grid item name
  product-price:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.4
    use: Price and discount percentage row
  caption:
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.2
    use: Shipping and product flags
rounded:
  sm: 2px
  md: 4px
  chip: 10px
  full: 9999px
spacing:
  xs: 2
  sm: 4
  md: 8
  base: 16
  lg: 24
  xl: 28
components:
  ghost-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #dddddd'
    rounded: 4px
    padding: 16px 16px 16px 20px
    height: 52px
    typography: 14px / 700
    hover: no visible change (measured 2026-09-29)
    pressed: 'bg #f4f4f4 fg #474747'
    focus: 'outline 1px #375fff, offset 2px (authored, not the browser ring) — measured 2026-09-29'
    states: default on home and magazine (2026-07-11); pressed first seen on the product outline CTA, then measured on the home '더보기' itself on 2026-09-17 and 2026-09-29; hover and keyboard focus measured 2026-09-29
    use: Editorial more and brand-home action
  carousel-control:
    type: button
    backgroundColor: rgba(0,0,0,0.5)
    textColor: '#ffffff'
    rounded: 9999px
    padding: 14px
    height: 52px
    typography: 16px / 400
    hover: bg rgba(0,0,0,0.9)
    pressed: 'bg #27272a'
    states: hover and pressed measured 2026-09-29 on the enabled next button (real :hover and :active); disabled look bg rgba(93,93,93,0.4), fg rgba(255,255,255,0.5), cursor not-allowed; keyboard focus not measured (the Tab walk moved the gallery and the button was disabled when reached)
    use: Product-image previous/next control
  product-grid-item:
    type: listItem
    backgroundColor: transparent
    rounded: 4px
    use: BEST product result with image, brand, name, discount, price, and shipping caption
  editorial-story-item:
    type: listItem
    backgroundColor: transparent
    rounded: 0px
    use: 29Magazine and Showcase story/list entry
  quantity-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #dddddd'
    rounded: 0px
    height: 36px
    typography: 16px / 500
    hover: no visible change (measured 2026-09-29)
    pressed: no authored change; the press focuses the field, so the browser default ring (not brand) appears — measured 2026-09-29
    focus: 'browser default ring (not brand); the border stays #dddddd — measured 2026-09-29'
    states: default captured 2026-07-11; hover, pressed and keyboard focus measured 2026-09-29; no authored focus style
    use: Product-detail quantity field
  nav-display-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    height: 48px
    typography: 40px / 700 / Pretendard Variable
    hover: '::before (parent) bar #000000, height 0→6px under the link; text colour unchanged'
    pressed: same bar as hover
    focus: browser default ring (not brand) — measured 2026-09-29; the bar is not drawn on focus
    states: default captured 2026-07-11 (four links on each of five surfaces); hover and pressed measured 2026-09-29 on 'Showcase' in the scrolled header, where the link renders 24px / 700 and the bar is 116px wide; keyboard focus measured at page top
    use: Desktop editorial navigation (BEST, Showcase, 29Magazine …)
  period-chip:
    type: button
    backgroundColor: rgba(93,93,93,0.08)
    textColor: '#474747'
    rounded: 10px
    padding: 0px 10px
    height: 32px
    typography: 13px / 400 / Pretendard Variable (label span)
    selected: 'bg #000000, fg #ffffff (the chip of the period in the URL: 실시간 for period=HOURLY)'
    hover: no visible change (measured 2026-09-29)
    pressed: 'fg #5d5d5d (label)'
    focus: 'outline 1px #375fff, offset 1px (authored) — measured 2026-09-29'
    states: unselected and selected captured 2026-07-11 (30px tall, padding 6px 10px then) and again in the 2026-09-29 survey (32px, padding 0 10px); hover, pressed and keyboard focus measured 2026-09-29 on '일간'
    use: BEST ranking period chips (실시간, 일간, 주간, 월간)
  product-image-link:
    type: card
    backgroundColor: transparent
    size: 251px x 251px
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    focus: browser default ring (not brand) — measured 2026-09-29
    states: default captured 2026-07-11 (40 on BEST); hover, pressed and keyboard focus measured 2026-09-29 on the first BEST item
    use: Image link of a BEST product item, inside product-grid-item (the rank badge is its label)
  buy-cta:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 18px
    height: 44px
    typography: 14px / 700
    states: default captured 2026-07-11 and seen again in the 2026-09-29 survey; never pressed (a purchase action), so no state is declared
    use: Product-detail '바로 구매하기'
  quantity-stepper:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #dddddd (no inner edge)'
    rounded: 4px 0px 0px 4px (minus); 0px 4px 4px 0px (plus)
    size: 36px x 36px
    states: default captured 2026-07-11; no state sample
    use: Quantity minus and plus buttons ('감소', '증가') either side of quantity-input
  option-thumbnail:
    type: button
    backgroundColor: transparent
    border: '1px solid #dddddd'
    rounded: 2px
    size: 74px x 74px
    selected: 'border 1px #000000'
    states: default and selected captured 2026-07-11 and seen again in the 2026-09-29 survey; no pointer-state sample
    use: Product option thumbnail (colour option), an a role=button
  editorial-tag:
    type: button
    backgroundColor: transparent
    border: '1px solid #d4d4d4'
    rounded: 2px
    padding: 0px 9px
    height: 25px
    states: default captured 2026-07-11 (24 on 29Magazine); no state sample
    use: 29Magazine story tag chip
fonts:
  roles:
    sans: Pretendard Variable
---

# 29CM

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 29CM; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/29cm/DESIGN.md
