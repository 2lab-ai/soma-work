---
name: Wolt
colors:
  brand: '#66cbf0'
  brand-hovered: '#56bee3'
  brand-pressed: '#4ab1d5'
  brand-surface: '#dcf7ff'
  brand-text: '#145367'
  brand-text-hovered: '#0e4253'
  brand-deep: '#08303e'
  focus: '#23748f'
  fill: '#151727'
  fill-hovered: '#363b57'
  foreground: '#272b42'
  input-text: '#202125'
  text-hovered: '#5e5b59'
  canvas: '#ffffff'
  surface: '#f5f1ed'
  surface-secondary: '#fbf8f5'
  surface-hovered: '#eeeae5'
  border: '#c3beb9'
  border-subdued: '#ded9d4'
  border-selected: '#3899bb'
  inverse: '#21201f'
  negative: '#c83527'
  positive: '#77d377'
  warning: '#ffad52'
  input-hover: '#009de0'
  input-focus: '#0f2594'
typography:
  body:
    fontSize: 16px
    use: navigation, buttons and the address field, on the system sans
rounded:
  sm: 8px
  md: 12px
  lg: 20px
  pill: 9999px
components:
  button-register:
    type: button
    backgroundColor: transparent
    textColor: '#145367'
    rounded: 12px
    height: 46px
    padding: 0 16px
    typography: 16px / 500
    hover: transparent
    focus: 'outline 3px solid #23748f'
    use: Registrieren in the header, in --al-color-text-brand. Hover changes nothing (confirmed with :hover matched); focus draws a 3px teal outline — --al-color-outline-focused.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#272b42'
    rounded: 8px
    height: 24px
    typography: 16px / 500
    hover: 'fg #5e5b59'
    focus: 'outline 3px solid #23748f'
    use: Anmelden and Jobs — the ink label warms to --al-color-text-hovered on hover; focus is the same teal outline.
  input-address:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#202125'
    rounded: 100px
    height: 58px
    padding: 16px 52px
    typography: 16px / 400
    hover: 'border #009de0'
    focus: 'border #0f2594'
    use: Lieferadresse eingeben — the address pill with a transparent 2px border that turns cyan on hover and indigo on focus; no outline on this control.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: DD Scoop
---

# Wolt

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Wolt; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/wolt/DESIGN.md
