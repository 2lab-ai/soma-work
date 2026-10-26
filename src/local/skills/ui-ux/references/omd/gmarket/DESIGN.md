---
name: Gmarket
colors:
  primary: '#da120d'
  brand: '#da120d'
  error: '#ef2b2a'
  canvas: '#ffffff'
  surface: '#ffffff'
  foreground: '#222222'
  muted: '#757575'
  on-primary: '#ffffff'
  hairline: '#e0e0e0'
  success: '#00c400'
  accent-smile: '#ffd200'
  accent-stardelivery: '#7130f3'
  accent-connect: '#00c3a0'
  club-navy: '#002041'
  club-blue: '#497cff'
  event-bf: '#f1266d'
  event-bs: '#fd4e28'
  event-bsd: '#7b00e7'
typography:
  section-hero:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.2
    use: Hero module section H2
  section-compact:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.2
    use: Compact module H2
  card-title:
    fontSize: 18.72px
    fontWeight: 700
    lineHeight: 1.3
    use: Card H3 heading
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body, card title, primary nav
  body-strong:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.4
    use: Price emphasis, strong body
  secondary:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Secondary nav, filter/utility
  utility:
    fontSize: 13.3333px
    fontWeight: 400
    lineHeight: 1.4
    use: Utility text, tooltip, swiper label
  meta:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Meta text, footer notices, micro-badge
  price-modifier:
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.4
    use: Price-modifier label 쿠폰적용가
rounded:
  sm: 3px
  md: 4px
  lg: 20px
  full: 9999px
spacing:
  micro: 4
  sm: 8
  md: 16
  lg: 24
  module: 64
components:
  button-primary:
    type: button
    backgroundColor: '#da120d'
    textColor: '#ffffff'
    rounded: 4px
    padding: 14px 24px
    typography: 16px / 700
    use: Highest-intent purchase CTA, one per surface
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #e0e0e0'
    rounded: 3px
    typography: 14px / 400
    use: Chrome-utility actions, footer button
  button-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#666666'
    border: '1px solid #e0e0e0'
    rounded: 20px
    typography: 16px / 400
    states: 'active fg #222222'
    use: Home module entry pills, GNB sub-category chips
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '2px solid #222222'
    rounded: 0px
    height: 44px
    typography: 16px / 400
    use: Header search field, signature dark-stroked
  input-filter:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #e0e0e0'
    rounded: 3px
    typography: 14px / 400
    use: Filter / sort refinement strip
  card-product:
    type: card
    backgroundColor: '#ffffff'
    rounded: 6px
    shadow: none
    padding: 8px 0
    use: 'Home / bestsellers product card; title #222222, price #da120d 700, separation via gutter not shadow'
  badge-discount:
    type: badge
    backgroundColor: '#fff5f5'
    textColor: '#da120d'
    rounded: 3px
    typography: 12px / 700
    use: Discount-rate badge, percentage-off
  badge-club:
    type: badge
    backgroundColor: '#002041'
    textColor: '#ffd200'
    rounded: 4px
    typography: 11px / 700
    use: Smile Club loyalty badge
  chip-delivery:
    type: badge
    backgroundColor: '#ffd200'
    textColor: '#222222'
    rounded: 3px
    padding: 2px 6px
    typography: 11px / 500
    use: '스마일배송 yellow chip; 무료배송 gray #f5f5f5, StarDelivery purple #7130f3 w/ white text'
  nav-anchor:
    type: tab
    textColor: '#222222'
    padding: 17px 0px 20px
    typography: 16px / 400
    active: 'current fg #da120d, 2px bottom border #222222 on hover'
    use: GNB top primary anchor
  layer-recent:
    type: dialog
    backgroundColor: '#ffffff'
    border: '1px solid #e0e0e0'
    shadow: none
    use: 'Recent-products layer; title 16px/700 #222222'
  banner-event:
    type: card
    backgroundColor: '#f1266d'
    textColor: '#ffffff'
    use: 'BF/BS/BSD full-bleed event-week module; BS #fd4e28, BSD #7b00e7'
fonts:
  roles:
    sans: Gmarket Sans
    mono: system-ui
---

# Gmarket

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Gmarket; reproduced for educational reference. Full prose: https://oh-my-design.kr/gmarket/design.md
