---
name: Brandi
colors:
  canvas: '#ffffff'
  ink: '#202429'
  promo-active: '#ff365d'
  action-direct: '#1e1e1e'
  action-partner: '#00c73c'
  action-on: '#ffffff'
  option-border: '#e6e6e6'
  option-border-disabled: '#e1e1e1'
  badge-surface: '#ebeef2'
  badge-text: '#808893'
typography:
  product-action:
    fontSize: 17px
    fontWeight: 500
    use: Observed direct and partner purchase links on both captured product pages.
  option:
    fontSize: 13px
    fontWeight: 400
    use: Inherited page text on the product-option trigger and expanded list containers (the page body records the same values); not a measured option-label style.
  badge:
    fontSize: 13px
    fontWeight: 700
    use: Observed product-detail badge.
rounded:
  product-action: 6px
  option: 6px
  option-menu: 6px
  badge: 6px
spacing:
  action-x: 4
  action-y: 18
  option-item: 16
  badge-x: 8
  badge-y-start: 2
  badge-y-end: 3
components:
  product-badge:
    type: badge
    backgroundColor: '#ebeef2'
    textColor: '#808893'
    rounded: 6px
    padding: 2px 8px 3px
    typography: 13px / 700 / Noto Sans KR
    use: Observed product-detail metadata badge.
  product-buy-button:
    type: button
    backgroundColor: '#1e1e1e'
    textColor: '#ffffff'
    rounded: 6px
    padding: 18px 4px
    height: 61px
    typography: 17px / 500 Noto Sans KR
    states: default on both product pages (surface-2 capture 17, surface-3 capture 16); the bundle holds no state frame for any Brandi element
    use: Direct purchase link (a.btn-buy) at surface-2::[data-omd-capture="17"], 206 x 61
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  product-partner-buy-button:
    type: button
    backgroundColor: '#00c73c'
    textColor: '#ffffff'
    rounded: 6px
    padding: 18px 4px
    height: 62px
    typography: 17px / 500 Noto Sans KR
    states: default on both product pages (surface-2 capture 18, surface-3 capture 17); no state frame
    use: Adjacent partner purchase link (a.btn-n-buy) at surface-2::[data-omd-capture="18"], 206 x 62
  product-cart-button:
    type: button
    backgroundColor: '#ffffff'
    border: '1px #e3e5e8'
    rounded: 6px
    size: 62px x 62px
    states: default on two icon links per product page (capture 19, 20); no state frame
    use: Icon link (a.btn-cart-ico) beside the purchase links at surface-2::[data-omd-capture="19"]; its font size is 0px, so no label style is claimed
  product-option-select:
    type: input
    backgroundColor: '#ffffff'
    border: '1px #e6e6e6'
    rounded: 6px
    size: 560px x 50px
    states: 'rest on the first option trigger on both product pages (surface-2 capture 15, surface-3 capture 14); activating it opened the option list (expanded, menu-open); the second trigger (capture 16) is disabled and records border 1px #e1e1e1; no pointer-state frame'
    use: 'Product option trigger (span, role button, aria-haspopup listbox) at surface-2::[data-omd-capture="15"]; its own #202429 13px / 400 Spoqa Han Sans equals the inherited page text, so it is treated as a container and no label style is claimed'
  product-option-list:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #e6e6e6 on the sides and bottom'
    rounded: 0px 0px 6px 6px
    padding: 0px 0px 1px
    size: 560px x 241px
    states: captured open after the option trigger was activated on both product pages (expanded, menu-open)
    use: 'Option list (ul, role listbox) at surface-2::[data-omd-interaction-capture="menu-0-0"]; its #202429 13px / 400 is the inherited page text on a container, so no label style is claimed'
  product-option-item:
    type: listItem
    backgroundColor: '#ffffff'
    border: '1px #e1e1e1 on the bottom edge of the wrapping li'
    padding: 16px
    height: 59px
    states: four option rows captured in the open list; the last wrapper has no divider; no state frame
    use: Option row (div, role option) at surface-2::[data-omd-interaction-capture="menu-0-2"], 558 x 59; inherited 13px / 400 type, so no label style is claimed
  product-detail-tab:
    type: tab
    textColor: '#9a9a9e'
    border: '4px #f2f2f2 on the bottom edge of the parent li'
    padding: 17px 4px 22px
    height: 68px
    typography: 20px / 400 Noto Sans KR
    selected: 'fg #202429, 20px / 500, parent li bottom border 4px #1e1e1e'
    states: rest on three tabs (capture 22-24); the tab whose li has class active (label capture 21) differs from them and is recorded as selected; no state frame
    use: Product-detail section tab label (a) at surface-2::[data-omd-capture="22"], 290 x 68, inside li in ul.tab
  product-text-tab:
    type: tab
    textColor: '#a4a4a8'
    padding: 0px 0px 0px 17px
    height: 32px
    typography: 22px / 400 Noto Sans KR
    selected: 'fg #1e1e1e'
    states: rest on two tabs (capture 26, 27); the link with class active (capture 25) differs from them and is recorded as selected; no state frame
    use: Product-page text tab link (a) at surface-2::[data-omd-capture="26"]
  product-pagination:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#9a9a9e'
    border: '1px #e6e6e6'
    rounded: 0px
    padding: 0px 4px
    size: 46px x 46px
    typography: 17px / 400 / 46px Noto Sans KR
    selected: 'fg #202429'
    states: rest on eight page links (capture 29-32, 42-45); the links with class page active (capture 28, 41) differ from them and are recorded as selected; no state frame
    use: Product-page pagination link (a.page) at surface-2::[data-omd-capture="29"]
  home-promo-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#808893'
    border: '1px #d3d7df'
    rounded: 26px
    padding: 0px 24px
    height: 46px
    typography: 18px / 400 / 46px Spoqa Han Sans
    selected: 'bg #ff365d, border 1px #ff365d, fg #ffffff, 18px / 700'
    states: rest on one slide (li swiper-slide-next, label capture 27); the li with class active (label captures 26, 37) differs from it and is recorded as selected; no state frame
    use: 'Home promotional slider tab: an li holding the label link, label at home::[data-omd-capture="27"]; fill, border, radius, padding and height sit on the li'
  home-more-link:
    type: button
    backgroundColor: transparent
    textColor: '#5f6773'
    border: '1px #d3d7df'
    rounded: 28px
    padding: 15px
    size: 320px x 53px
    typography: 14px / 400 Spoqa Han Sans
    states: default on three links (capture 36, 46, 57); no state frame
    use: Home section more link (a) at home::[data-omd-capture="36"]
fonts:
  roles:
    ui: Noto Sans KR
---

# Brandi

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Brandi; reproduced for educational reference. Full prose: https://oh-my-design.kr/brandi/design.md
