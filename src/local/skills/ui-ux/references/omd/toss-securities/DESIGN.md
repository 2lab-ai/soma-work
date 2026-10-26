---
name: Toss Securities
colors:
  primary: '#3182f6'
  canvas: '#ffffff'
  foreground: '#1a1f29'
  body: '#4e5968'
  on-primary: '#ffffff'
  dialog-canvas: '#fbfcfd'
typography:
  compact:
    fontSize: 13px
    fontWeight: 600
    lineHeight: 20px
    use: Public WTS compact menu-trigger text
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 23.2px
    use: Public WTS body, tab, menu, and dialog copy
  marketing-heading:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 28.8px
    use: Investment-product marketing H1
rounded:
  compact-control: 7px
  primary: 8px
  menu: 12px
  dialog: 16px
  marketing-pill: 100px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 14
  xl: 16
components:
  wts-primary-entry:
    type: button
    backgroundColor: '#3182f6'
    textColor: '#ffffff'
    rounded: 8px
    padding: 6px 12px
    height: 32px
    typography: 14px / 600 / 16px
    states: default, focus, and pressed observed; colors and geometry remained the same in the retained samples (the dump records no opacity, outline, or transform; the focus frame followed a mouse press and is not a keyboard focus-visible measurement)
    use: Public WTS compact primary link-action
    pressed: 'bg #2272eb, shadow none (:hover + :active)'
    focus: outline rgba(0, 12, 30, 0.8) solid 2px on :focus-visible
  investment-primary:
    type: button
    backgroundColor: '#3182f6'
    textColor: '#ffffff'
    rounded: 100px
    padding: 11px 14px
    height: 40px
    typography: 15px / 600 / 18px
    states: 'default observed; the capture holds no hover, pressed, or focus sample for this element (corrected 2026-09-29: those state names belong to the same-class secondary pill)'
    use: Investment-products marketing primary action
  wts-selection-dialog:
    type: dialog
    backgroundColor: '#fbfcfd'
    textColor: '#4e5968'
    rounded: 16px
    size: 640px x 600px
    typography: 16px / 400 / 23.2px
    states: dialog-open observed
    use: Public WTS selection dialog container
  wts-tab:
    type: tab
    backgroundColor: transparent
    textColor: rgba(18, 31, 51, 0.47)
    rounded: 0px
    padding: 0px
    height: 36px
    typography: 16px / 400 / 18.4px
    selected: fg rgba(26, 31, 41, 0.89)
    hover: fg rgba(22, 31, 46, 0.61)
    pressed: fg rgba(22, 31, 46, 0.61)
    states: unselected rest, selected, hover, and pressed sampled; focus not sampled
    use: Public WTS tab
  wts-segmented-radio:
    type: toggle
    backgroundColor: transparent
    textColor: rgba(18, 31, 51, 0.47)
    rounded: 5px
    padding: 0px
    height: 24px
    typography: 16px / 400 / 18.4px
    checked: fg rgba(26, 31, 41, 0.89)
    hover: bg rgba(13, 25, 74, 0.02)
    pressed: bg rgba(7, 25, 76, 0.04)
    states: unchecked rest, checked, hover, and pressed sampled; focus not sampled
    use: Public WTS segmented radio option (role=radio)
  wts-content-card-link:
    type: card
    backgroundColor: transparent
    textColor: '#4e5968'
    rounded: 12px
    padding: 4px
    size: 248px x 176px
    typography: 16px / 400 / 23.2px
    hover: bg rgba(13, 25, 74, 0.02)
    pressed: bg rgba(7, 25, 76, 0.04)
    states: rest, hover, and pressed sampled; focus not sampled
    use: Public WTS content card link
  wts-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: rgba(22, 31, 46, 0.61)
    rounded: 9px
    padding: 8px 12px
    height: 36px
    typography: 14px / 600 / 20px
    states: rest sampled; the hover, pressed, and focus frames caught a colour transition in progress (alpha 0.61 to 0.63-0.67, different per link), so no state value is declared
    use: Public WTS top navigation link
  wts-menu-trigger:
    type: button
    backgroundColor: rgba(7, 25, 76, 0.04)
    textColor: rgba(26, 31, 41, 0.89)
    rounded: 7px
    padding: 4px 8px
    height: 28px
    typography: 13px / 600 / 20px
    shadow: rgba(0, 23, 51, 0.02) 0px 0px 0px 0.5px inset
    states: rest sampled; expanded and menu-open observed through the captured menu interaction; no pointer-state sample
    use: Public WTS compact menu trigger
  wts-expanded-menu:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#4e5968'
    rounded: 12px
    size: 160px x 204px
    typography: 16px / 400 / 23.2px
    shadow: rgb(212, 217, 225) 0px 0px 0px 0.5px inset, 0 16px 24px -2px rgba(0,0,0,0.06), 0 8px 56px rgba(0,0,0,0.1)
    states: expanded and menu-open observed
    use: Public WTS expanded menu container
  wts-dialog-input:
    type: input
    backgroundColor: transparent
    textColor: rgba(0, 12, 30, 0.8)
    rounded: 0px
    padding: 0px
    height: 17px
    typography: 15px / 600 / 17.25px
    states: observed only inside the opened selection dialog; no pointer-state sample
    use: Text field inside the public WTS selection dialog; its visible frame belongs to a wrapper the capture did not sample
  investment-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: rgba(253, 253, 255, 0.75)
    rounded: 0px
    padding: 0px 8px
    height: 14px
    typography: 14px / 600 / 14px
    hover: 'fg #3182f6'
    pressed: 'fg #3182f6'
    states: rest, hover, and pressed sampled on nine header controls; focus not sampled
    use: Investment-products header navigation link
  investment-secondary:
    type: button
    backgroundColor: rgba(2, 32, 71, 0.05)
    textColor: rgba(3, 18, 40, 0.7)
    rounded: 100px
    padding: 11px 14px
    height: 40px
    typography: 15px / 600 / 18px
    states: rest sampled; the hover, pressed, and focus frames differ only by transition-frame deltas (fill alpha 0.05 to 0.055, fractional inset-shadow width), so no state value is declared
    use: Investment-products secondary pill
fonts:
  roles:
    sans: Toss Product Sans
---

# Toss Securities

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Toss Securities; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/toss-securities/DESIGN.md
