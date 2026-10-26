---
name: Satispay
colors:
  brand: '#ff3d00'
  brand-hover: '#e53700'
  brand-pressed: '#b52b00'
  brand-100: '#ffd8cc'
  primary: '#290402'
  foreground: '#290402'
  text-body: '#3e3e3e'
  text-muted: '#707272'
  text-placeholder: '#979797'
  off-white: '#fffbef'
  canvas: '#ffffff'
  surface-elevated: '#f6f6f6'
  surface-canvas: '#e5e5e5'
  stroke: '#dcdcdc'
  secondary: '#ededed'
  ondark: '#2c2c2c'
  lilac: '#a493f6'
  sage: '#c6ef5d'
  mint: '#56ab2b'
  danger: '#ff1414'
typography:
  button:
    fontSize: 14px
    fontWeight: 500
    use: header buttons
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  pill: 9999px
components:
  button-signup:
    type: button
    backgroundColor: '#290402'
    textColor: '#fffbef'
    rounded: 12px
    height: 48px
    typography: 14px / 500
    shadow: rgba(41,4,2,0.08) 0 2px 8px
    hover: '#290402'
    use: Iscriviti in the header — aubergine with an off-white label and a soft shadow. Hover changes nothing (pseudo-elements included); focus adds Tailwind's default slate ring.
    padding: 8px 16px
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: 'shadow transparent 0px 0px 0px 0px, transparent 0px 0px 0px 0px, transparent 0px 0px 0px 0px, #94a3b8 0px 0px 0px 1px, rgba(41, 4, 2, 0.08) 0px 2px 8px 0px on :focus-visible'
  button-login:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#232323'
    rounded: 12px
    height: 48px
    typography: 14px / 500
    hover: '#ffffff'
    use: Accedi — white with a dark label and the same soft shadow; no hover change.
  nav-segment:
    type: button
    backgroundColor: transparent
    textColor: '#979797'
    rounded: 10px
    height: 37px
    typography: 14px / 500
    hover: 'rgba(0,0,0,0.05) + fg #290402'
    pressed: 'rgba(0,0,0,0.05) + fg #290402'
    use: Welfare, Negozi — audience tabs in grey that gain a 5% black wash and turn aubergine on hover and press; the active tab (Privati) is aubergine.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Bricolage Grotesque
---

# Satispay

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Satispay; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/satispay/DESIGN.md
