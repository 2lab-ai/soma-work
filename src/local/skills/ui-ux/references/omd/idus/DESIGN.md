---
name: idus (Backpackr)
colors:
  primary: '#ef7014'
  on-primary: '#ffffff'
  ink: '#111111'
  text: '#333333'
  text-muted: '#666666'
  text-faint: '#999999'
  sale: '#ff4b50'
  border-strong: '#acacac'
  chip-border: '#e1e1e1'
  highlight-border: '#ffc6a0'
  divider: '#e5e7eb'
  surface: '#f5f5f5'
  canvas: '#ffffff'
typography:
  cta:
    fontSize: 18px
    fontWeight: 700
    use: 구매하기 and 선물하기 labels on the product page
  section-title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.2
    use: Section headings over the product rows, 24px line
  tab:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.2
    use: 'Main category tabs in the header row, 19.2px line, in #666666'
  price:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.2
    use: Card price and the coral discount rate beside it, 19.2px line
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Product names on cards, 21px line, in #333333'
  chip:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.2
    use: Shortcut and filter chip labels, 16.8px line; 700 when selected
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.2
    use: Maker names on cards and header utility links, 14.4px line
  icon-label:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.2
    use: Labels under the header icons (장바구니 and neighbours), 13.2px line
  micro:
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.2
    use: Grey business badge on ranking cards, 12px line
rounded:
  cta: 2px
  card: 6px
  chip: 36px
  highlight: 100px
  pill: 1000px
spacing:
  tag-x: 6
  utility-x: 8
  card: 10
  chip-x: 12
  button-x: 16
components:
  button-primary:
    type: button
    backgroundColor: '#ef7014'
    textColor: '#ffffff'
    rounded: 2px
    height: 48px
    padding: 0px 16px
    typography: 18px / 700
    hover: '::before overlay (black) at opacity 0.1'
    pressed: '::before overlay at opacity 0.2'
    states: 'probe on the product page: hover and pressed darken the fill through a black ::before overlay (0 -> 0.1 -> 0.2); the button itself computes transition all 0s; focus was not measured'
    use: 구매하기, the product page's purchase action, 580 x 48 at the end of the action row
    focus: no visible change (measured 2026-10-16) on :focus-visible
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #acacac'
    rounded: 2px
    height: 48px
    padding: 0px 16px
    typography: 18px / 700
    hover: '::before overlay (#333333) at opacity 0.1'
    pressed: '::before overlay at opacity 0.2'
    states: 'probe: the same overlay pattern in the label colour; focus not measured'
    use: 선물하기 beside 구매하기 on the product page, 189.3 x 48
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#ef7014'
    border: '1px solid #ef7014'
    rounded: 2px
    height: 40px
    padding: 0px 16px
    typography: 14px / 700
    hover: '::before overlay (#ef7014) at opacity 0.1'
    pressed: '::before overlay at opacity 0.2'
    states: 'probe: an orange ::before wash; focus not measured'
    use: 작품문의 (ask the maker) on the product page, 189 x 40
  button-block:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #acacac'
    rounded: 2px
    height: 44px
    padding: 0px 16px
    typography: 16px / 700
    states: rest on the captured instance; no pointer frame and not probed, so no hover, pressed or focus value is declared
    use: Full-width 360 x 44 outlined button near the foot of the ranking page; the same outline at 40px and 14px / 700 on the gift shop
  utility-button:
    type: button
    textColor: '#666666'
    height: 30px
    padding: 0px 8px
    typography: 12px / 400
    states: rest on 12 instances; no pointer frame, so no state value is declared
    use: Text links in the header utility row, present on all three browse pages
  rank-badge:
    type: badge
    backgroundColor: '#ef7014'
    textColor: '#ffffff'
    rounded: 0px 0px 6px
    size: 30px x 30px
    typography: 16px / 700
    use: 'Number badge in the top-left corner of ranked product images on 실시간 인기 and the gift shop: 6 instances in orange, the other 18 in #111111'
  chip-outline:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#111111'
    border: '1px solid #e1e1e1'
    rounded: 36px
    padding: 0px 12px 0px 5px
    height: 42px
    typography: 14px / 400
    use: Icon-led shortcut chips under the home hero (13 instances)
  chip-highlight:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#111111'
    border: '1px solid #ffc6a0'
    rounded: 36px
    height: 42px
    use: The one shortcut chip with a peach outline, inside a 100px-radius highlight wrapper, 165 x 42
  chip-fill:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#333333'
    rounded: 36px
    padding: 0px 16px
    height: 40px
    typography: 14px / 400
    selected: 'bg #333333, fg #ffffff, 14px / 700'
    states: selected read from rest values; no pointer frame
    use: Filter chips on the gift shop; the medium size is 36px tall with 12px side padding
  business-badge:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#666666'
    rounded: 1000px
    padding: 0px 6px
    height: 16px
    typography: 10px / 400
    use: Small grey badge in the review line of ranking cards
  nav-tab:
    type: tab
    textColor: '#666666'
    height: 48px
    typography: 16px / 400
    states: rest on 24 instances; the current tab carries no distinct rest value in the capture and no pointer frame was recorded
    use: Main category tabs across the header (24 instances on three pages)
  sub-tab:
    type: tab
    textColor: '#666666'
    border: '0px 0px 1px #e5e7eb'
    height: 44px
    typography: 14px / 400
    selected: 'fg #333333, 14px / 700'
    states: selected read from rest values; no pointer frame
    use: Period and category sub-tabs on 실시간 인기
  product-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 6px
    size: 243px x 305px
    use: Vertical product card; the image corners take the 6px radius and nothing computes a shadow
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    typography: 14px / 400
    states: rest only; the field was not focused or typed into, so no focus or error value is declared
    use: Borderless header search field, 396 x 17 inside the search bar
fonts:
  roles:
    body: '-apple-system, "system-ui", "Malgun Gothic", "맑은 고딕", helvetica, "Apple SD Gothic Neo", sans-serif'
---

# idus (Backpackr)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to idus (Backpackr); reproduced for educational reference. Full prose: https://oh-my-design.kr/idus/design.md
