---
name: Shinhan Card
colors:
  primary: '#005df9'
  canvas: '#ffffff'
  surface: '#f8f9fc'
  tonal: '#f0f4fa'
  surface-accent: '#ebf0ff'
  ink: '#101828'
  body: '#475467'
  slate: '#344054'
  muted: '#667085'
  border: '#e4e7ec'
  danger: '#f44f4f'
  danger-bg: '#fff6f5'
typography:
  display:
    fontSize: 32px
    fontWeight: 800
    lineHeight: 1.5
    letterSpacing: '-0.64px'
    use: Promotional card title observed on the public home surface
  title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.56px'
    use: Detail-page heading observed on credit-card product surface
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.71
    letterSpacing: '-0.28px'
    use: Product-page reading text and controls
  compact:
    fontSize: 12px
    fontWeight: 300
    lineHeight: 1.67
    letterSpacing: '-0.24px'
    use: Compact product and menu metadata
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
spacing:
  tight: 4
  compact: 8
  regular: 12
  surface: 20
components:
  badge-danger:
    type: badge
    backgroundColor: '#fff6f5'
    textColor: '#f44f4f'
    rounded: 12px
    padding: 2px 8px
    typography: 11px / 500
    use: Tinted text badge on the public home surface (shc-badge--text type-tint theme-red)
  badge-blue:
    type: badge
    backgroundColor: '#ebf0ff'
    textColor: '#005df9'
    rounded: 12px
    padding: 2px 8px
    typography: 11px / 500
    use: Tinted text badge on the public home surface (shc-badge--text type-tint theme-blue)
  primary-action:
    type: button
    backgroundColor: '#005df9'
    rounded: 16px
    padding: 2px 12px
    height: 56px
    states: default captured on all three surfaces (home anchor 312 px wide; detail-page buttons 580 px wide); the capture holds no state frame for this action
    use: shc-btn theme-primary size-xl at home::[data-omd-capture="27"] (also surface-2 capture 32, surface-3 capture 29). The root computes the inherited body text (#101828, 14px / 400 / 24px) and its label element was not sampled, so no label colour or type is declared
    typography: 14px / 400
    pressed: transform matrix(0.96, 0, 0, 0.96, 0, 0) (+1 nested-layer changes) (:hover + :active)
  toned-capsule-action:
    type: button
    backgroundColor: '#f0f4fa'
    rounded: 20px
    padding: 8px 12px
    height: 40px
    states: default captured on four buttons across both detail pages; no state frame
    use: 'shc-capsule-btn theme-tonal size-md at surface-2::[data-omd-capture="29"], 104 and 150 px wide. The button computes #101828 / 14px / 400, the inherited body text, and its label was not sampled separately, so no label style is declared'
  product-detail-tile:
    type: card
    backgroundColor: '#f8f9fc'
    rounded: 16px
    padding: 20px
    size: 580px x 181px
    states: default captured on both detail pages; no state frame
    use: 'Benefit tile: a <button> wrapping one benefit-list item at surface-2::[data-omd-capture="20"]; a second tile (capture 22) measures 580 x 149 with the same fill, radius and padding. Its #101828 / 14px / 400 are container values, so no text style is declared'
  badge-indigo:
    type: badge
    backgroundColor: rgba(173, 173, 255, 0.2)
    textColor: '#6268ff'
    rounded: 12px
    padding: 2px 8px
    typography: 11px / 500
    use: Tinted text badge on the public home surface (shc-badge--text type-tint theme-indigo), one occurrence, 134 px wide; its fill is translucent
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#101828'
    rounded: 0px
    padding: 0px
    height: 72px
    typography: 16px / 500 / Digital One Shinhan
    hover: 'fg #005df9, 16px / 700'
    pressed: 'fg #005df9, 16px / 700'
    states: 'rest, hover, and pressed sampled on the six header links of each of the three surfaces (captures 1-6, 18 elements); every hover and pressed frame records fg rgb(0, 93, 249) and weight 700, the primary blue. The border-colour delta in those frames sits on a 0px border and is not a border. Focus is not declared from the bundle: the collector presses before it focuses'
    use: Global header menu link (a.role_link, line height 72px, tracking -0.32px) at home::[data-omd-capture="1"]
  login-button:
    type: button
    backgroundColor: transparent
    rounded: 8px
    padding: 2px 4px
    height: 24px
    shadow: rgb(228, 231, 236) 0px 0px 0px 1px
    states: default captured on all three surfaces; each surface also records a pressed frame whose dumped properties equal the rest frame. Opacity, outline, and transform are outside the dump, so no pressed value is declared
    use: 'Header login action (a.shc-btn theme-quaternary size-xs btn-login) at home::[data-omd-capture="12"]; its outline is a 1px box-shadow spread in #e4e7ec, not a border. The root computes the inherited body text (#101828, 14px / 400), so no label style is declared'
  text-button:
    type: button
    backgroundColor: transparent
    rounded: 8px
    padding: 0px
    height: 24px
    states: default captured on home (three anchors) and on both detail pages (buttons); the detail-page buttons (surface-2 capture 16, surface-3 captures 16 and 23) record pressed frames whose dumped properties equal the rest frame, so no pressed value is declared
    use: Text button (shc-txt-btn theme-secondary size-xs) at home::[data-omd-capture="28"]; theme-tertiary buttons share the geometry. The root computes the inherited body text, so no label style is declared
  dropdown-button:
    type: button
    backgroundColor: transparent
    rounded: 8px
    padding: 5px 12px
    height: 32px
    shadow: rgb(208, 213, 221) 0px 0px 0px 1px inset
    states: default captured; activating it opens the dropdown-menu (menu interaction with expanded and menu-open recorded on all three surfaces); no pointer-state frame
    use: 'Dropdown trigger (button.shc-dropdown__btn, two per surface) at home::[data-omd-capture="102"]; its outline is a 1px inset box-shadow in #d0d5dd, not a border. The root computes the inherited body text, so no label style is declared'
  dropdown-menu:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #e4e7ec'
    rounded: 12px
    padding: 0px
    size: 116px x 125px
    shadow: rgba(12,17,29,0.1) 0px 4px 16px 0px
    states: open list captured after the menu interaction (expanded, menu-open) on all three surfaces
    use: 'Open dropdown list (ul.shc-dropdown__option, role=menu) at home::[data-omd-interaction-capture="menu-0-0"]; its own #101828 / 14px / 400 are container values, and the option labels are the dropdown-option component'
  dropdown-option:
    type: listItem
    backgroundColor: transparent
    textColor: '#344054'
    border: '1px #f0f4fa'
    padding: 5px 12px
    height: 30px
    typography: 12px / 500 / Digital One Shinhan
    states: rendered only in the open menu; no pointer-state frame
    use: 'Menu option (li.shc-dropdown__option-item holding an a role=menuitem) at home::[data-omd-interaction-capture="menu-0-1"]; from the second option on, each item carries a 1px #f0f4fa top border only (31 px tall). The label colour and type are the menuitem anchor values (menu-0-2, 12px / 500 / 20px, tracking -0.26px)'
  filter-chip:
    type: button
    backgroundColor: '#f8f9fc'
    textColor: '#344054'
    border: '1px #e4e7ec'
    rounded: 18px
    padding: 0px 16px 0px 12px
    height: 36px
    typography: 14px / 300 / Digital One Shinhan
    states: 'five chips captured at rest on home; the chip whose button carries class is-active (capture 37) computes a #344054 label fill, #ffffff text, a 1px #344054 border, and 14px / 500. No aria-selected is recorded, so that pairing rests on the class name; no pointer-state frame'
    use: Home chip row (button.shc-chip, captures 37-41); the visible style sits on its span.shc-chip__label (home::span), while the button root computes the inherited body text
  detail-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#667085'
    padding: 0px 4px
    height: 51px
    typography: 16px / 500 / Digital One Shinhan
    states: 'two tabs captured at rest on each detail page; the label inside the tab carrying class is-active computes fg #101828, 16px / 700. No aria-selected is recorded, so that pairing rests on the class name; no pointer-state frame'
    use: 'Card-detail tab bar (div.shc-tab type-btn card-detail-tab, #ffffff, 580 x 51) with two a.shc-tab__btn tabs 290 px wide; the label style sits on span.shc-tab__btn-text (surface-2::span, line height 27px), while the anchor root computes the inherited body text'
  important-note-trigger:
    type: button
    backgroundColor: transparent
    textColor: '#344054'
    rounded: 0px
    padding: 20px 0px
    height: 66px
    typography: 16px / 500 / Digital One Shinhan
    states: captured expanded on both detail pages (class is-active), with its region (#section1) open at 580 x 496 and padding 8px 0px 24px; no pointer-state frame
    use: Important-notes accordion trigger (button.shc-accordion__trigger shc-important-note__title) at surface-2::[data-omd-capture="31"]; line height 26px
fonts:
  roles:
    sans: Digital One Shinhan
---

# Shinhan Card

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Shinhan Card; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/shinhancard/DESIGN.md
