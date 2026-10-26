---
name: OTTO
colors:
  brand: '#eb001f'
  primary: '#dc001d'
  foreground: '#212121'
  interactive: '#2366cb'
  interactive-hover: '#1c50a0'
  interactive-pressed: '#143b75'
  text-secondary: '#6d6d6d'
  disabled-text: '#949494'
  frame: '#f0f0f0'
  disabled-background: '#e5e5e5'
  disabled-border: '#cccccc'
  canvas: '#ffffff'
  hint: '#dcf2ff'
  success: '#227642'
  warning: '#ae4518'
  error: '#b30023'
  sustainable: '#50734d'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: the header search field
  small:
    fontSize: 14px
    fontWeight: 400
    use: product tiles
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  xxl: 24px
components:
  link-product:
    type: button
    backgroundColor: transparent
    textColor: '#2366cb'
    rounded: 0px
    typography: 14px / 400
    hover: 'fg #1c50a0'
    pressed: 'fg #143b75'
    use: A product tile link on a search results page — the interactive blue darkens a step on hover and another on press.
  input-search:
    type: input
    backgroundColor: transparent
    textColor: '#212121'
    rounded: 0px
    height: 48px
    padding: 1px 2px 1px 16px
    typography: 16px / 400
    hover: transparent
    focus: transparent
    use: The header search field (Wonach suchst du?). None of its measured values change on hover, press or focus.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#212121'
    rounded: 0px
    height: 40px
    hover: rgba(0,0,0,0.03)
    pressed: rgba(0,0,0,0.09)
    use: Mein Konto in the header. The link itself does not change; an ::after overlay darkens it by 3% on hover and 9% when pressed.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: OTTO Sans
---

# OTTO

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to OTTO; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/otto/DESIGN.md
