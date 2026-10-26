---
name: LEGO
colors:
  brand-yellow: '#ffd400'
  brand-red: '#dd1a22'
  brand-blue: '#006cb7'
  primary: '#005ad2'
  primary-hovered: '#0045b7'
  primary-pressed: '#011c58'
  accent: '#ffd502'
  accent-hovered: '#fac400'
  accent-pressed: '#ef9f00'
  emphasis: '#e96f14'
  neutral-action: '#f2f2f2'
  neutral-action-hovered: '#e5e5e5'
  neutral-action-pressed: '#cbcbcb'
  foreground: '#141414'
  text-strong: '#3d3d3d'
  text-subdued: '#636363'
  canvas: '#ffffff'
  header: '#f7f7f7'
  border: '#b0b0b0'
  focus: '#4695f0'
  play-zone: '#d1e8ff'
  black: '#000000'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: body and highlighted links
  nav:
    fontSize: 16px
    fontWeight: 500
    use: SHOP / DISCOVER / HELP
rounded:
  sm: 4px
  pill: 999px
components:
  button-static-light:
    type: button
    backgroundColor: rgba(255,255,255,0.85)
    textColor: '#141414'
    rounded: 999px
    height: 48px
    padding: 0 20px
    typography: 18px / 500
    hover: rgba(255,255,255,0.9)
    pressed: rgba(255,255,255,0.94)
    focus: 'ring 0 0 0 2px #4695f0'
    use: Continue / START PLAYING on the site chooser — translucent white pills on blue and yellow panels (--ds-color-action-static-light-*).
  button-play-zone:
    type: button
    backgroundColor: '#d1e8ff'
    textColor: '#000000'
    rounded: 999px
    height: 32px
    padding: 0 12px
    typography: 14px / 500
    hover: '#a8bed4'
    pressed: '#8096ab'
    focus: 'ring 0 0 0 2px #4695f0'
    use: PLAY ZONE in the utility bar (sk-button--primary) — pale blue pill; hover and press darken it (served as lab(), converted).
  nav-menu:
    type: button
    backgroundColor: transparent
    textColor: '#141414'
    rounded: 0px
    height: 22px
    typography: 16px / 500
    hover: transparent
    pressed: transparent
    focus: 'ring 0 0 0 2px #4695f0'
    use: SHOP / DISCOVER / HELP on the yellow bar — hover and press turn the transparent 3px bottom border black.
  link-highlight:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#dd1a22'
    border: '#dd1a22'
    rounded: 4px
    height: 34px
    padding: 5px 20px
    typography: 16px / 400
    hover: '#000000'
    pressed: '#000000'
    focus: 'ring 0 0 0 2px #4695f0'
    use: RETIRING SOON — white with LEGO red text; hover and press invert to black with white text.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Cera Pro
---

# LEGO

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to LEGO; reproduced for educational reference. Full prose: https://oh-my-design.kr/lego/design.md
