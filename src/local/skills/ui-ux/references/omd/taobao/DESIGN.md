---
name: Taobao
colors:
  brand: '#ff5000'
  gold: '#b88449'
  brand-wash: '#fff1eb'
  brand-border: '#ffd5c2'
  foreground: '#1f1f1f'
  secondary: '#7a7a7a'
  tertiary: '#999999'
  disabled: '#cccccc'
  border: '#d6d6d6'
  divider: '#ebebeb'
  canvas: '#ffffff'
  surface-1: '#f5f5f5'
  surface-2: '#f7f7f7'
  surface-3: '#fafafa'
typography:
  body:
    fontSize: 14px
    use: The default size for nearly everything — nav, card titles, category links
  small:
    fontSize: 12px
    use: Prices, tags, secondary metadata under a card
  lead:
    fontSize: 16px
    use: Search field and the two theme-orange buttons
  title:
    fontSize: 20px
    use: The few section headings on the page
rounded:
  sm: 4px
  md: 8px
  lg: 12px
components:
  button-search:
    type: button
    backgroundColor: '#ff5000'
    textColor: '#ffffff'
    rounded: 8px
    typography: 16px / 500
    hover: '#ff5000'
    pressed: '#ff5000'
    focus: '#ff5000'
    use: 'The search submit, 72×36. Measured at rest, hover, pressed and focus: all four are byte-identical — the button has no state styling at all.'
    height: 36px
    padding: 0px
  button-login:
    type: button
    backgroundColor: '#ff5000'
    textColor: '#ffffff'
    rounded: 12px
    typography: 16px / 900
    hover: '#ff5000'
    pressed: '#ff5000'
    focus: '#ff5000'
    use: The sign-in call to action, 224×48 at weight 900 — the single heaviest text on the page. Also identical across all four states.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# Taobao

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Taobao; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/taobao/DESIGN.md
