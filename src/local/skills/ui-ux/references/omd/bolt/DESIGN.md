---
name: Bolt
colors:
  action-primary: '#32bb78'
  action-active: '#1d965c'
  link-active: '#127042'
  border-action-secondary: '#5ae1a0'
  green-9: '#2b8659'
  green-10: '#18784c'
  focus-green: '#2a9c64'
  neutral-primary: '#2f313f'
  neutral-active: '#414a55'
  foreground: '#2f313f'
  text-inverted: '#fafafb'
  background: '#f7f9f8'
  canvas: '#ffffff'
  floor-grouped: '#f5f6f7'
  promo: '#5b68f6'
  promo-active: '#4450d5'
  danger: '#eb4755'
  danger-active: '#c91d2b'
  warning: '#f58300'
typography:
  button:
    fontSize: 18px
    fontWeight: 650
    use: hero app buttons
  small:
    fontSize: 14px
    fontWeight: 600
    use: header pills
rounded:
  lg: 40px
  pill: 9999px
components:
  button-app:
    type: button
    backgroundColor: '#2b8659'
    textColor: '#ffffff'
    rounded: 40px
    height: 48px
    padding: 0 24px
    typography: 18px / 650
    hover: '#18784c'
    pressed: '#18784c'
    focus: 'outline 2px solid #2a9c64'
    use: Get Bolt — green (--green-9) darkening to --green-10 on hover; press also scales it to 97%; a 2px green focus outline.
  button-app-soft:
    type: button
    backgroundColor: rgba(1,34,18,0.067)
    textColor: rgba(0,10,7,0.627)
    rounded: 40px
    height: 48px
    padding: 0 24px
    typography: 18px / 650
    hover: rgba(0,31,21,0.098)
    pressed: rgba(0,31,24,0.13)
    use: Get Bolt Food — a translucent green-black tint stepping 6.7% → 9.8% → 13%, scaling to 97% when pressed.
  button-register:
    type: button
    backgroundColor: '#2f313f'
    textColor: '#ffffff'
    rounded: 9999px
    height: 32px
    padding: 0 16px
    typography: 14px / 600
    hover: '#414a55'
    pressed: '#414a55'
    use: 'Register in the header — neutral-primary pill lifting to neutral-active #414a55, scaling to 97.5% when pressed.'
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#2f313f'
    rounded: 9999px
    height: 32px
    padding: 8px 16px
    typography: 14px / 600
    hover: rgba(6,26,55,0.04)
    pressed: rgba(6,26,55,0.08)
    use: Support — a ghost pill tinting 4% on hover and 8% when pressed.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Inter
---

# Bolt

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bolt; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/bolt/DESIGN.md
