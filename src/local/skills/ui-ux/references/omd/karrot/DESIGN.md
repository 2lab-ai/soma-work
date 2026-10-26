---
name: Karrot
colors:
  primary: '#ff6f0f'
  primary-hover: '#ff9e66'
  primary-pressed: '#ff9e66'
  marketing: '#ff6600'
  canvas: '#ffffff'
  background: '#f2f3f6'
  surface: '#f7f8fa'
  foreground: '#212124'
  muted: '#868b94'
  on-primary: '#ffffff'
  hairline: '#eaebee'
  brand-tint: '#fff5f0'
  error: '#fa2314'
  info: '#009ceb'
  success: '#1aa174'
typography:
  h1:
    fontSize: 48px
    fontWeight: 700
  h2:
    fontSize: 42px
    fontWeight: 700
  h3:
    fontSize: 34px
    fontWeight: 700
  title:
    fontSize: 24px
    fontWeight: 700
  body:
    fontSize: 16px
    fontWeight: 400
  body-small:
    fontSize: 14px
    fontWeight: 400
rounded:
  sm: 6px
  md: 8px
  full: 9999px
spacing:
  sm: 4
  md: 8
  lg: 12
  xl: 16
  section: 64
components:
  marketing-primary:
    type: button
    backgroundColor: '#ff6600'
    textColor: '#ffffff'
    rounded: 9999px
    height: 36px
    padding: 4px 12px
    typography: 14px / 500
    hover: 'overlay #ffffff at 0.08 via ::before; bg stays #ff6600'
    pressed: 'overlay #ffffff at 0.12 via ::before; bg stays #ff6600'
    focus: 'ring 0 0 0 2px #ffffff, 0 0 0 4px #e14d00'
    states: 'default on two public surfaces (2026-07-11); hover, pressed and keyboard focus-visible measured 2026-09-29 with :hover, :active and :focus-visible matched; the fill never changes, so a background-only reading sees no change (corrected 2026-09-29: earlier text said hover not captured)'
    use: Karrot marketing-site CTA
  box-button:
    type: button
    backgroundColor: '#ff6f0f'
    textColor: '#ffffff'
    hover: '#ff9e66'
    pressed: '#ff9e66'
    disabled: 'bg #dcdee3 fg #adb1ba'
    states: 'primary, primary-low, secondary, danger, disabled, hover, keyboard. Pressed and hover share one background by design — SEED declares both as #ff9e66. Size and type scale are not promoted: the official preview renders one size and the reference documents five'
    use: SEED action with five documented sizes
  text-field:
    type: input
    states: outlined, underlined, focused, disabled, readonly, required, invalid
    use: SEED single-line form field
  tabs:
    type: tab
    states: selected, disabled, focus
    use: SEED category switching with indicator
  snackbar:
    type: toast
    states: default, success, warning, action focus
    use: SEED transient action feedback
  marketing-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#1a1c20'
    border: 1px solid rgba(26, 28, 32, 0.118)
    rounded: 9999px
    padding: 3px 11px
    height: 36px
    typography: 14px / 500 / 20px
    hover: 'overlay #eeeff1 at 0.24 via ::before'
    pressed: 'overlay #eeeff1 at 0.36 via ::before'
    focus: 'ring 0 0 0 2px #ffffff, 0 0 0 4px #e14d00'
    states: 'rest on both public surfaces in the 2026-07-11 capture and unchanged on 2026-09-29; hover, pressed and keyboard focus-visible measured 2026-09-29 with :hover, :active and :focus-visible matched; the fill stays transparent while a #eeeff1 ::before overlay carries hover and pressed; focus is a box-shadow ring with outline none'
    use: karrotmarket.com header outlined pill (About us)
  marketing-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#1a1c20'
    rounded: 9999px
    padding: 4px 12px
    height: 36px
    typography: 14px / 500 / 20px
    states: rest on both public surfaces in the 2026-07-11 capture; no hover, pressed or focus sample exists, so none is declared
    use: karrotmarket.com header ghost pill (Sign In)
  flag-menu-button:
    type: button
    backgroundColor: transparent
    textColor: '#1a1c20'
    border: 1px solid rgba(26, 28, 32, 0.118)
    rounded: 9999px
    size: 40px x 40px
    typography: 14px / 400 / 14px
    hover: 'bg #f3f4f5'
    pressed: 'bg #f3f4f5'
    states: 'rest, hover and pressed sampled on the home surface (2026-07-11): hover and pressed both fill #f3f4f5, the value the location chip also records; the about-page capture caught this control already at #f3f4f5, so rest is taken from home; opens a two-item menu (dialog-open); focus not sampled, and the control was not re-probed on 2026-09-29'
    use: karrotmarket.com header 40px circle showing a flag emoji; opens the flag menu
  flag-menu:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1a1c20'
    rounded: 8px
    padding: 4px
    size: 219px x 80px
    typography: 14px / 400 / 20px
    shadow: rgba(26, 28, 32, 0.08) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0.05) 0px 5px 10px 0px, rgba(0, 0, 0, 0.07) 0px 15px 25px 0px
    states: dialog-open observed on both public surfaces (2026-07-11)
    use: Popover menu opened by the flag button
  flag-menu-item:
    type: listItem
    backgroundColor: transparent
    textColor: '#1a1c20'
    rounded: 6px
    size: 211px x 36px
    typography: 14px / 400 / 20px
    states: rest observed inside the open menu (2026-07-11); no pointer-state sample
    use: Menu item (role=menuitem) inside the flag menu
  location-chip:
    type: button
    backgroundColor: transparent
    textColor: '#1a1c20'
    rounded: 9999px
    padding: 4px 8px
    height: 25px
    typography: 14px / 500 / 16.8px
    hover: 'bg #f3f4f5'
    pressed: 'bg #f3f4f5'
    states: 'rest, hover and pressed sampled (2026-07-11): hover and pressed both fill #f3f4f5, matching the flag button; keyboard focus not recorded'
    use: Location chip inside the search pill (area and radius, Manhattan · 30mi on 2026-09-29)
  search-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#2a3038'
    rounded: 9999px
    height: 60px
    typography: 18px / 400 / 20px
    shadow: 'rgba(0, 0, 0, 0.05) 0px 5px 10px 0px, rgba(0, 0, 0, 0.07) 0px 15px 25px 0px, #1a1c20 0px 0px 0px 2px'
    hover: 'ring 0 0 0 2px #1a1c20 (unchanged)'
    pressed: 'ring 0 0 0 2px #e14d00 (mouse-down focuses the field)'
    focus: 'ring 0 0 0 2px #e14d00'
    states: rest, hover, pressed and keyboard focus-visible measured 2026-09-29 with :hover, :active and :focus-visible matched; bg, radius, height and shadow belong to the 60px wrapper that carries the ring, fg and font to the input, whose values the 2026-07-11 capture records identically; hover changes nothing; pressed is the mouse-focus ring, not a separate :active style; the input itself keeps outline none
    use: 'karrotmarket.com search pill: a combobox input inside a ring-bearing wrapper'
  listing-card:
    type: card
    backgroundColor: transparent
    textColor: '#2a3038'
    rounded: 0px
    size: 187px x 255px
    typography: 16px / 700
    hover: image scale(1.05)
    pressed: image scale(1.05)
    states: 'hover and pressed measured 2026-09-29 with :hover and :active matched: the inner image scales to 1.05 and nothing else moves or recolours; keyboard focus shows only the browser default ring (outline auto), so no focus value is declared; fg and font are the title label, not the anchor (#2a3038 14px / 400); the 2026-07-11 capture holds 60 list items of the same 187 x 255 size'
    use: karrotmarket.com listing card link in the home feed (web only)
  footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#555d6d'
    height: 24px
    typography: 16px / 400
    hover: 'underline #555d6d'
    pressed: 'underline #555d6d'
    states: 'hover and pressed measured 2026-09-29 with :hover and :active matched (the Accept-only consent panel covering the link was hidden for the pointer pass): an underline appears; keyboard focus shows only the browser default ring (outline auto), so no focus value is declared; fg and font are the visible label, not the anchor (#2a3038 14px / 400)'
    use: karrotmarket.com footer text link (About Karrot)
  category-link:
    type: button
    backgroundColor: transparent
    textColor: '#1a1c20'
    height: 17px
    typography: 16px / 500
    hover: 'overlay (label span) #eeeff1 opacity 0→0.32; fg #1a1c20 unchanged'
    pressed: 'overlay (label span) #eeeff1 opacity 0→0.48; fg #1a1c20 unchanged'
    states: 'hover and pressed measured 2026-09-29 with :hover and :active matched: a #eeeff1 ::before overlay on the label span (99.4 x 48px) goes from opacity 0 to 0.32 on hover and 0.48 on pressed while the label stays #1a1c20, the About us overlay mechanism at higher opacities; the same on a second load and on the sibling Electronics & Appliances (corrected 2026-09-29: earlier text said no visible change, from a read that compared pseudo-elements on the anchor only); keyboard focus shows only the browser default ring (outline auto), so no focus value is declared; fg and font are the visible label, not the anchor (#2a3038 14px / 400)'
    use: karrotmarket.com category link in the home feed (Furniture and siblings)
  search-keyword-link:
    type: button
    backgroundColor: transparent
    textColor: '#1a1c20'
    height: 18px
    typography: 16px / 400 / 24px
    states: rest identical across the captured keyword links (2026-07-11, captures 8 to 39 checked); no pointer-state or focus sample, so none is declared
    use: Keyword text links listed under the search pill (ikea and siblings)
fonts:
  roles:
    sans: System
---

# Karrot

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Karrot; reproduced for educational reference. Full prose: https://oh-my-design.kr/karrot/design.md
