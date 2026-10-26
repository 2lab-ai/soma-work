---
name: Vinted
colors:
  primary: '#007782'
  primary-dark: '#004654'
  primary-extra-dark: '#112e33'
  primary-medium: '#86cdcf'
  primary-light: '#c9f0ee'
  primary-extra-light: '#e6fafa'
  foreground: '#15191a'
  text-subtle: '#5a6566'
  canvas: '#ffffff'
  surface-subtle: '#edf2f2'
  border: '#b6bebf'
  overlay-ink: '#0f1212'
  error: '#d04555'
  success: '#28865a'
  warning: '#f9bb42'
typography:
  body:
    fontSize: 16px
    fontWeight: 375
    use: search field and body text
  label:
    fontSize: 12px
    fontWeight: 500
    use: header button labels
rounded:
  sm: 6px
  md: 12px
  full: 3996px
components:
  button-sell:
    type: button
    backgroundColor: '#007782'
    textColor: '#ffffff'
    rounded: 6px
    height: 32px
    padding: 0 12px
    typography: 12px / 500
    hover: rgba(255,255,255,0.02)
    pressed: rgba(255,255,255,0.08)
    focus: rgba(255,255,255,0.02)
    use: Sell now in the header — a teal fill with a white label; hover and focus lay a white ::after at 2%, press at 8%.
  button-auth:
    type: button
    backgroundColor: transparent
    textColor: '#007782'
    border: '#007782'
    rounded: 6px
    height: 32px
    padding: 0 12px
    typography: 12px / 500
    hover: rgba(0,119,130,0.02)
    pressed: rgba(0,119,130,0.08)
    focus: rgba(0,119,130,0.02)
    use: Sign up | Log in — teal outline and label; a teal ::after at 2% on hover and focus, 8% when pressed.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: V_INTER
---

# Vinted

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Vinted; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/vinted/DESIGN.md
