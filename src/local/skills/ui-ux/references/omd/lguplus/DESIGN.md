---
name: LG유플러스
colors:
  primary: '#e6007e'
  ink: '#000000'
  canvas: '#ffffff'
  muted: '#888888'
  soft: '#f5f5f5'
  border: '#ebebeb'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed public Home body
  subscription-action:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Observed public subscription purchase action
rounded:
  none: 0px
  row: 8px
  primary-cta: 20px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
components:
  home-primary-cta:
    type: button
    backgroundColor: '#e6007e'
    textColor: '#ffffff'
    border: '0px solid #ffffff'
    rounded: 20px
    padding: 0px 30px
    height: 40px
    typography: 16px / 400 / Pretendard
    states: default captured; the capture holds no pointer-state frame for any Home element (interactionCount 0 counts dialog, menu, and tab expansions only), so no hover, focus, pressed, disabled, or error value was observed
    use: Public Home solid CTA at home::[data-omd-capture="19"]
    pressed: 'bg #730024 (:hover + :active)'
    focus: 'bg #730024, outline #ffffff dotted 1px on :focus-visible'
  subscription-information-row:
    type: listItem
    backgroundColor: transparent
    textColor: '#222222'
    border: '1px solid #ebebeb'
    rounded: 8px
    padding: 19px
    height: 65px
    typography: 14px / 500 / nskr
    use: Public subscription product information row at surface-2::[data-omd-capture="14"]
  home-section-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 34px
    typography: 28px / 400 / Pretendard
    selected: 'fg #e6007e, 28px / 700'
    states: unselected rest and aria-selected=true variant captured; no pointer-state sample on Home
    use: Public Home recommendation tab (role=tab) at home::[data-omd-capture="42"]
  home-outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #bbbbbb'
    rounded: 16px
    padding: 0px 24px
    height: 32px
    typography: 14px / 400 / Pretendard
    states: default captured; no pointer-state sample on Home
    use: Public Home small outline button (.c-btn-outline-2-s) at home::[data-omd-capture="81"]
  home-arrow-link:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 36px
    typography: 24px / 700 / Pretendard
    states: default captured; no pointer-state sample on Home
    use: Public Home section link with arrow (.c-link-arr-1) at home::[data-omd-capture="56"]
  home-recommendation-card:
    type: card
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 16px
    padding: 40px
    size: 312px x 405px
    typography: 16px / 400 / Pretendard
    states: default captured; no pointer-state sample on Home
    use: 'Public Home recommendation card: a framed list item holding a full-bleed link at home::[data-omd-capture="44"]'
  subscription-gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 24px
    typography: 16px / 700 / nskr
    hover: 'fg #e6007e'
    pressed: 'fg #e6007e'
    states: default, hover, and pressed sampled; focus not sampled
    use: Public subscription-page header navigation link at surface-2::[data-omd-capture="4"]
  subscription-utility-link:
    type: tab
    backgroundColor: transparent
    textColor: '#888888'
    rounded: 0px
    padding: 6px 0px
    height: 30px
    typography: 12px / 400 / nskr
    states: default captured; no pointer-state sample
    use: Public subscription-page utility link at surface-2::[data-omd-capture="0"]
  subscription-purchase-cta:
    type: button
    backgroundColor: '#e6007e'
    textColor: '#ffffff'
    border: '0px solid #ffffff'
    rounded: 90px
    padding: 15.5px
    height: 55px
    typography: 16px / 700 / nskr
    states: default captured; the pressed frame moved one channel unit (rgb(230, 0, 126) to rgb(229, 0, 126)), consistent with a transition frame, so no pressed value is declared
    use: Public subscription purchase CTA at surface-2::[data-omd-capture="15"]
  subscription-more-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #000000'
    rounded: 8px
    padding: 15.5px
    height: 57px
    typography: 16px / 700 / nskr
    states: default captured; no pointer-state sample
    use: Public subscription outline more button (.pg-button-prod_detail-more) at surface-2::[data-omd-capture="23"]
  subscription-add-control:
    type: button
    backgroundColor: '#f5f5f5'
    textColor: '#000000'
    rounded: 8px
    padding: 0px 10px
    height: 60px
    typography: 12px / 700 / nskr
    states: default captured; no pointer-state sample
    use: Public subscription compact add control (.pr-btne.add) at surface-2::[data-omd-capture="34"]
  subscription-pagination-link:
    type: button
    backgroundColor: transparent
    textColor: '#888888'
    rounded: 0px
    padding: 8px 12px
    height: 34px
    typography: 14px / 400 / nskr
    selected: 'bg #f3f3f3, fg #000000, 14px / 700, radius 4px'
    states: default and current-page variant captured; no pointer-state sample
    use: Public subscription review pagination link (.page-link) at surface-2::[data-omd-capture="81"]
  subscription-carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    textColor: transparent
    border: '1px solid #ebebeb'
    rounded: 50%
    size: 32px x 32px
    shadow: rgba(0, 0, 0, 0.08) 0px 2px 6px 0px
    states: default captured; no pointer-state sample
    use: Public subscription carousel arrow (.slick-arrow) at surface-2::[data-omd-capture="27"]; its label text is visually hidden
fonts:
  roles:
    home: Pretendard
    subscription: nskr
---

# LG유플러스

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to LG유플러스; reproduced for educational reference. Full prose: https://oh-my-design.kr/lguplus/design.md
