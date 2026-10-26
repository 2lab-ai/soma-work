---
name: Coolblue
colors:
  brand: '#0090e3'
  primary: '#285dab'
  primary-hover: '#1c4684'
  primary-inset-hover: '#14315c'
  action: '#008a00'
  action-hover: '#026902'
  action-inset-hover: '#005200'
  link: '#0072d1'
  icon: '#0088d6'
  foreground: '#1b1e24'
  text-subtle: '#6c6e75'
  text-additional: '#5b5c62'
  accent: '#ff6600'
  canvas: '#ffffff'
  surface-secondary: '#f2f7fc'
  surface-tertiary: '#f7f7f7'
  border: '#d2d5d5'
  danger: '#da001e'
  warning: '#ed9f02'
typography:
  button:
    fontSize: 13px
    fontWeight: 700
    use: buttons
  body:
    fontSize: 13px
    fontWeight: 400
    use: search field and links
rounded:
  sm: 4px
components:
  button-main:
    type: button
    backgroundColor: '#285dab'
    textColor: '#ffffff'
    rounded: 4px
    height: 48px
    padding: 12px 16px 14px
    typography: 13px / 700
    shadow: 'inset 0 -2px 0 #1c4684'
    hover: '#1c4684'
    focus: 'outline 2px solid #14315c'
    use: 'A blue main button on the home page — --cb-color-background-interactive-main-base with a 2px darker inset along its bottom. Hover darkens it to #1c4684 and the inset to #14315c; focus drops the inset and draws a 2px navy outline.'
  button-action:
    type: button
    backgroundColor: '#008a00'
    textColor: '#ffffff'
    rounded: 4px
    height: 48px
    padding: 12px 16px 14px
    typography: 13px / 700
    shadow: 'inset 0 -2px 0 #026902'
    hover: '#026902'
    focus: 'outline 2px solid #14315c'
    use: 'The green action style (--cb-color-background-interactive-action-base), measured on the consent dialog''s button: hover #026902 with the inset deepening to #005200; focus a 2px navy outline.'
  link:
    type: button
    backgroundColor: transparent
    textColor: '#0072d1'
    rounded: 0px
    height: 52px
    typography: 13px / 400
    hover: 'underline #0072d1'
    focus: 'box-shadow 0 0 0 2px #14315c'
    use: A blue content link — hover underlines it; focus rounds it to 4px and draws a 2px navy ring.
  input-search:
    type: input
    backgroundColor: transparent
    textColor: '#1b1e24'
    rounded: 0px
    height: 38px
    padding: 0 8px 0 0
    typography: 13px / 400
    hover: transparent
    focus: transparent
    use: The header search field. None of its own measured values change on hover or focus; the frame belongs to a wrapper that was not read.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Open Sans
    display: Dobra Slab
---

# Coolblue

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Coolblue; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/coolblue/DESIGN.md
