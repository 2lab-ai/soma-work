---
name: KREAM
colors:
  canvas: '#ffffff'
  primary: '#222222'
  foreground: '#222222'
  surface: '#f5f5f5'
  muted: '#4e4e4e'
  hairline: '#f0f0f0'
  on-primary: '#ffffff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: Observed default live-commerce text on home and search.
  utility:
    fontSize: 13px
    fontWeight: 400
    use: Observed search-filter control text.
  search:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.21
    use: Observed search input text.
  tab-active:
    fontSize: 16px
    fontWeight: 700
    use: Observed active search-tab label.
rounded:
  none: 0px
  sm: 6px
  recovery: 8px
  merchandising-panel: 16px
  search-filter-pill: 30px
spacing:
  xxs: 2
  xs: 4
  sm: 6
  md: 8
  lg: 12
  xl: 24
components:
  filter-pill:
    type: button
    backgroundColor: '#f4f4f4'
    textColor: '#4e4e4e'
    rounded: 30px
    padding: 0px 8px
    height: 30px
    typography: 13px / 400 / Pretendard Variable
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Search filter (button.filter_button.tint.shape_pill) at surface-3::[data-omd-capture="18"]; 7 instances
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  filter-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#4e4e4e'
    border: '1px solid #f0f0f0'
    rounded: 6px
    padding: 0px 6px 0px 4px
    height: 30px
    typography: 13px / 400 / Pretendard Variable
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Search filter (button.filter_button.line.shape_rect) at surface-3::[data-omd-capture="25"]; 9 instances
  home-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    rounded: 0px
    padding: 13px 0px
    height: 44px
    typography: 16px / 400 / Pretendard Variable
    selected: 16px / 700, no bottom border (class active)
    states: rest and route-active variants captured; no pointer-state frame
    use: Home category tab (a.tab) at home::[data-omd-capture="13"]; 7 instances on home; the active one is home::[data-omd-capture="15"]
  search-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    border: 2px solid transparent (bottom edge only)
    rounded: 0px
    padding: 0px
    height: 44px
    typography: 16px / 400 / Pretendard Variable
    selected: '16px / 700, 2px solid #222222 bottom border (class active)'
    states: rest and route-active variants captured; no pointer-state frame
    use: Search result-type tab at surface-3::[data-omd-capture="15"]; the active one is surface-3::[data-omd-capture="14"]
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px 13px 0px 1px
    height: 29px
    typography: 24px / 700 / Pretendard Variable
    states: default captured; no focus frame
    use: Search input (input.input_search.show_placeholder_on_focus) at surface-3::[data-omd-capture="12"], 468 x 29, letter-spacing -0.36px
  product-card:
    type: card
    backgroundColor: transparent
    rounded: 6px
    padding: 0px 0px 10px
    size: 238px wide, 319px to 340px high
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Search product card link (a.product_card) at surface-3::[data-omd-capture="37"]; 15 instances; its brand, name and price labels are child elements that were not sampled
  recovery-button:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: 1px solid rgba(0, 0, 0, 0.6)
    rounded: 8px
    padding: 0px
    height: 36px
    typography: 13px / 300 / Pretendard Variable
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Recovery-route home button (button.button-home) at surface-2::[data-omd-capture="12"], 103 x 36; route-local, not a primary commerce CTA
  merchandising-panel:
    type: card
    backgroundColor: '#f5f5f5'
    rounded: 16px
    padding: 0px
    size: 1188px x 475px
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Home merchandising panel link (a.layout_stack) at home::[data-omd-capture="21"] through "76" (56 panel links); the enclosing div.flicking-panel computes a 0px radius, so the 16px corner belongs to the link
  gnb-link:
    type: button
    backgroundColor: transparent
    textColor: '#222222'
    rounded: 0px
    padding: 0px
    height: 24px
    typography: 20px / 400 / Pretendard Variable
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Header main-navigation link (a.gnb_link.badge) at home::[data-omd-capture="8"], letter-spacing -0.3px, three per route on all three routes; the enclosing li.gnb_item computes 16px, which is not the label size
  header-icon-button:
    type: button
    backgroundColor: transparent
    rounded: 0px
    padding: 0px
    size: 40px x 40px
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Header search button (button.btn_search) at home::[data-omd-capture="10"] and cart link (a.header-cart-button) at "11"; icon-only (textLength 0), on all three routes
  sort-trigger:
    type: button
    backgroundColor: transparent
    textColor: rgba(0, 0, 0, 0.8)
    rounded: 0px
    padding: 0px
    height: 16px
    typography: 13px / 400 / Pretendard Variable
    states: default captured; the bundle holds no pointer-state frame for any KREAM element
    use: Search sort trigger (button.sorting_title) at surface-3::[data-omd-capture="36"], 54 x 16
fonts:
  roles:
    ui: Pretendard Variable
---

# KREAM

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KREAM; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kream/DESIGN.md
