---
name: Epidemic Sound
colors:
  brand-pink: '#ff82c2'
  pink-hovered: '#e575af'
  pink-pressed: '#cc689b'
  brand-off-white: '#f1f0eb'
  brand-off-black: '#292c33'
  brand-azur: '#20afff'
  brand-yellow: '#ffda40'
  brand-red: '#ff6138'
  brand-fog: '#cfd6e5'
  brand-ecru: '#e4d9cf'
  brand-moss: '#bfbda8'
  brand-stone: '#9793a5'
  background-base: '#121418'
  foreground: '#000000'
  inverse-hovered: '#272727'
  inverse-pressed: '#333333'
  canvas: '#ffffff'
  light-tint: '#3d4d74'
  positive: '#5ad363'
  purple: '#bb76ff'
typography:
  display:
    fontSize: 80px
    fontWeight: 500
    use: hero heading
  button:
    fontSize: 14px
    fontWeight: 600
    use: pill buttons
rounded:
  pill: 10000px
components:
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 10000px
    height: 44px
    padding: 4px 16px
    typography: 14px / 600
    hover: '#272727'
    pressed: '#333333'
    focus: 'outline 2px solid #000000'
    use: 'Create free account — black pill on the off-white page (--es-color-action-primary-inverse-*); lifts to #272727 and #333333.'
  button-secondary:
    type: button
    backgroundColor: rgba(61,77,116,0.12)
    textColor: '#000000'
    rounded: 10000px
    height: 44px
    padding: 4px 16px
    typography: 14px / 600
    hover: rgba(61,77,116,0.18)
    pressed: rgba(61,77,116,0.24)
    focus: 'outline 2px solid #000000'
    use: Log in — a translucent blue-grey pill that deepens 12% → 18% → 24%.
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 10000px
    height: 44px
    padding: 4px 16px
    typography: 14px / 600
    hover: rgba(61,77,116,0.06)
    pressed: rgba(61,77,116,0.12)
    focus: 'outline 2px solid #000000'
    use: What we offer / For business — ghost navigation pills tinting 6% on hover and 12% when pressed.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Sebenta
    sans: Inter
---

# Epidemic Sound

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Epidemic Sound; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/epidemicsound/DESIGN.md
