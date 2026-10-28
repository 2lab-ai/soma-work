---
name: Yanolja
colors:
  primary: '#000000'
  foreground: '#1b1c1f'
  canvas: '#ffffff'
  surface-muted: '#f7f8fb'
  surface-hover: '#f2f3f7'
  muted: '#6e6f73'
  hairline: '#dadbdf'
  brand-yanolja-orange: '#f54b1e'
typography:
  display:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.19
    use: Observed h2 on NOL product surfaces
  search:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.22
    use: Observed search input text
  action:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.19
    use: Observed pill action
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.19
    use: Observed outlined action
  label:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.21
    use: Observed 48px utility action
  badge:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.17
    use: Observed neutral badge
rounded:
  sm: 8px
  md: 16px
  full: 9999px
spacing:
  xxs: 2
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
components:
  utility-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 16px
    padding: 0px
    typography: 14px/700 Pretendard
    hover: '#f7f8fb'
    use: '48px product utility button; hover capture switches to #f7f8fb'
    pressed: '#f7f8fb'
    states: 'hover and pressed frames sampled on home captures 14 and 15; in all four frames bg #ffffff becomes #f7f8fb and the shadow rgba(0,0,0,0.1) 0 0 8px becomes rgba(0,0,0,0.2) 0 0 6px; focus not declared'
    height: 48px
    focus: no visible change (measured 2026-10-16) on :focus-visible
  neutral-badge:
    type: badge
    backgroundColor: '#f7f8fb'
    textColor: '#1b1c1f'
    rounded: 9999px
    padding: 2px 8px 2px 6px
    typography: 12px/400 Pretendard
    use: 26px product badge observed on hotel and leisure
  action-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1b1c1f'
    rounded: 9999px
    padding: 4px 16px
    height: 52px
    typography: 16px / 700 / Pretendard
    states: default captured; no pointer-state frame for this control
    use: White pill action at home::[data-omd-capture="50"], 127 x 52; 6 instances across home and leisure
  outlined-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1b1c1f'
    border: '1px solid #1b1c1f'
    rounded: 16px
    padding: 4px 16px
    height: 52px
    typography: 16px / 400 / Pretendard
    states: default captured; no pointer-state frame for this control
    use: Outlined full-width action at surface-2::[data-omd-capture="101"], 768 x 52; 4 instances across hotel and leisure
  ghost-action:
    type: button
    backgroundColor: transparent
    textColor: '#1b1c1f'
    rounded: 16px
    padding: 4px 16px
    height: 52px
    typography: 16px / 700 / Pretendard
    hover: 'bg #f2f3f7'
    pressed: 'bg #f2f3f7'
    states: hover and pressed frames sampled on this one element, both opaque rgb(242, 243, 247) from a fully transparent base; the neighbouring header actions move toward the same RGB but were caught mid-transition; focus not declared
    use: Home transparent 16px-radius action at home::[data-omd-capture="7"], 147 x 52 near the top of the page (top 74)
  icon-button:
    type: button
    backgroundColor: transparent
    textColor: '#1b1c1f'
    rounded: 16px
    padding: 4px
    size: 56px x 56px
    states: default captured; no pointer-state frame for this control
    use: Icon-only control (textLength 0) at surface-2::[data-omd-capture="7"]; "9" and "11" and the same three on leisure match
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#1b1c1f'
    rounded: 0px
    padding: 0px
    height: 22px
    typography: 18px / 700 / Pretendard
    states: default captured; no focus frame
    use: Search text input at surface-2::[data-omd-capture="1"], 582 x 22; hotel and leisure
  search-bar-button:
    type: button
    backgroundColor: transparent
    border: '1px solid #1b1c1f'
    rounded: 8px
    padding: 0px 20px 0px 24px
    size: 520px x 60px
    shadow: rgba(0, 0, 0, 0.1) 0px 0px 8px 0px
    states: default captured; no pointer-state frame for this control
    use: Hotel bordered search trigger (class includes border-fill-neutral-main, shadow-2) at surface-2::[data-omd-capture="12"]; its own 10px / 400 computed font is the page root size, and the visible label sits in child elements that were not sampled
  footer-bordered-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #dadbdf'
    rounded: 5px
    padding: 0px 12px
    height: 32px
    typography: 12px / 400 / Pretendard
    states: default captured; no pointer-state frame; no open state captured
    use: Home bordered row button (flex, justify-between; class includes border-line-neutral-weak3, bg-static-white) at home::[data-omd-capture="131"], 328 x 32 near the page foot (top 6017)
  footer-text-link:
    type: button
    backgroundColor: transparent
    textColor: '#6e6f73'
    rounded: 0px
    padding: 0px
    height: 18px
    typography: 12px / 400 / Pretendard
    states: default captured; no pointer-state frame
    use: Home text button (class text-text-neutral-sub underline) at home::[data-omd-capture="149"], 144 x 18 (top 6252); the underline is named by the class, text-decoration is not in the style dump
  overlay-icon-button:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.5)
    rounded: 9999px
    size: 32px x 32px
    states: default captured; no pointer-state frame
    use: Home translucent circular icon-only button (class includes rounded-full) at home::[data-omd-capture="12"] (top 499), beside a 32px-high counter button at "13"
fonts:
  roles:
    sans: Pretendard
---

# Yanolja

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Yanolja; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/yanolja/DESIGN.md
