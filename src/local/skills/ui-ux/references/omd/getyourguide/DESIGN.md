---
name: GetYourGuide
colors:
  brand: '#ff5533'
  primary: '#0071eb'
  primary-hover: '#304c84'
  foreground: '#1a2b49'
  label-secondary: '#63687a'
  label-tertiary: '#858995'
  critical: '#c72a3d'
  critical-hover: '#951d2b'
  success: '#007850'
  warning: '#a65200'
  border: '#dcdfe4'
  border-hover: '#a0a8b6'
  surface-secondary: '#ebeef1'
  highlight: '#e1f0ff'
  canvas: '#ffffff'
  poolside-blue: '#81beff'
  plant-green: '#a1d55d'
  flamingo-pink: '#f4cdd7'
  basking-yellow: '#ffd938'
typography:
  button:
    fontSize: 24px
    fontWeight: 700
    use: the search button
  nav:
    fontSize: 14px
    fontWeight: 400
    use: header links
rounded:
  pill: 80px
components:
  button-search:
    type: button
    backgroundColor: '#0071eb'
    textColor: '#ffffff'
    border: '#0071eb'
    rounded: 80px
    height: 56px
    padding: 13px 32px
    typography: 24px / 700
    hover: '#304c84'
    pressed: '#304c84'
    focus: 'outline 2px solid #0071eb'
    use: 'Suchen, the search button — --interactive-primary; hover and press turn it to --interactive-primary-hovered #304c84, focus draws a 2px outline in the primary blue.'
  link-header:
    type: button
    backgroundColor: transparent
    textColor: '#63687a'
    rounded: 0px
    height: 64px
    typography: 14px / 400
    hover: transparent
    use: Profil in the header, in --label-secondary. Hover and press change nothing, and focus draws no indicator.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: GT Eesti
---

# GetYourGuide

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to GetYourGuide; reproduced for educational reference. Full prose: https://oh-my-design.kr/getyourguide/design.md
