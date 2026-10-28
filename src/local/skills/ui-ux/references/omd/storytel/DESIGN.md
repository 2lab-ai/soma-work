---
name: Storytel
colors:
  brand: '#ff501c'
  brand-hover: '#c6461b'
  brand-press: '#a33815'
  primary: '#101010'
  primary-hover: '#333333'
  foreground: '#101010'
  sand: '#dcd5cd'
  invert-hover: '#f2eeeb'
  invert-press: '#eae6e0'
  canvas: '#ffffff'
  text-muted: '#c2c2c2'
  text-secondary: '#5c5c5c'
  brand-light: '#ffeae4'
  yellow: '#ffc739'
  green: '#1fa37d'
  info: '#50a2ef'
typography:
  button:
    fontSize: 16px
    fontWeight: 600
    use: hero pill button
  nav:
    fontSize: 16px
    fontWeight: 400
    use: header links
rounded:
  sm: 4px
  pill: 1000px
components:
  button-invert:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#101010'
    rounded: 1000px
    height: 48px
    typography: 16px / 600
    hover: '#f2eeeb'
    pressed: '#eae6e0'
    use: 'Starta erbjudandet on the dark hero — --color-btn-primary-invert: white pill, hover #f2eeeb, press #eae6e0. Focus is the browser''s ring. Prova nu in the header is a 40px, 13px version.'
    padding: 12px 20px
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    height: 22px
    typography: 16px / 400
    hover: 'fg #ff501c'
    pressed: 'fg #ff501c'
    use: Ljudböcker, E-böcker, Podcasts in the header — white links that turn Storytel orange on hover and press.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Storytel Euclid
---

# Storytel

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Storytel; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/storytel/DESIGN.md
