---
name: Ocado
colors:
  primary: '#4d216d'
  primary-hover: '#240b3d'
  primary-ink: '#2e004d'
  primary-surface: '#e9e4ed'
  primary-surface-hover: '#c9bcd3'
  primary-muted: '#a690b6'
  action: '#f1c500'
  action-hover: '#e6a300'
  promotion: '#c51d25'
  promotion-text: '#a90016'
  foreground: '#2d333a'
  placeholder: '#4c5157'
  disabled: '#96999c'
  decoration-contrast: '#6c7075'
  decoration: '#e6ecf0'
  background: '#f3f5f8'
  canvas: '#ffffff'
  success: '#116623'
  warning: '#bd5407'
  error: '#9e171c'
  error-text: '#a31800'
typography:
  s:
    fontSize: 12px
    use: '--salt-text-s-font-size (.857rem at the 14px root)'
  m:
    fontSize: 14px
    use: '--salt-text-m-font-size, the 14px root size; buttons at 600'
  l:
    fontSize: 16px
    use: '--salt-text-l-font-size'
  display:
    fontSize: 20px
    use: '--salt-display-font-size (1.43rem)'
rounded:
  default: 8px
  lg: 12px
  pill: 20px
spacing:
  s05: 2
  s1: 4
  s2: 8
  s4: 16
  s8: 32
  s16: 64
  s32: 128
components:
  button-secondary:
    type: button
    backgroundColor: '#e9e4ed'
    textColor: '#2e004d'
    rounded: 8px
    height: 40px
    padding: 0 8px
    typography: 14px / 600
    hover: '#c9bcd3'
    pressed: '#c9bcd3'
    use: Log in, and the search submit beside the product field — lavender with deep-purple text, darkening to --salt-button-secondary-hover-background-color. Focus is the browser's ring.
  button-action:
    type: button
    backgroundColor: '#f1c500'
    textColor: '#2d333a'
    border: '#f1c500'
    rounded: 8px
    height: 40px
    padding: 0 8px
    typography: 14px / 600
    hover: '#e6a300, border #e6a300'
    pressed: '#e6a300, border #e6a300'
    use: Add on a product tile — the action yellow, the colour of putting something in the basket, darkening to --interaction-action.
  button-primary:
    type: button
    backgroundColor: '#4d216d'
    textColor: '#ffffff'
    rounded: 7px
    height: 42px
    hover: '#240b3d'
    pressed: '#240b3d'
    use: The purple primary button. Logged out on the home page it appears once — as the Live Chat launcher — darkening to --salt-button-primary-hover-background-color.
  card-link:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#2d333a'
    rounded: 8px
    height: 92px
    padding: 16px
    typography: 14px / 400
    hover: shadow rgba(0,0,0,0.08) 0 2px 12px
    pressed: shadow rgba(0,0,0,0.08) 0 2px 12px
    use: The Register card — white, flat at rest, lifting with --salt-elevation-shadow-1 on hover.
fonts:
  roles:
    sans: Source Sans Pro
---

# Ocado

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ocado; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/ocado/DESIGN.md
