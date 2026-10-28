---
name: momo購物網
colors:
  primary: '#d62872'
  primary-hover: '#d9006c'
  brand: '#e5047e'
  canvas: '#f2f2f2'
  surface: '#fafafa'
  foreground: '#404040'
  muted: '#727272'
  on-primary: '#ffffff'
  accent-link: '#027bff'
  error: '#dd2222'
  error-delete: '#ea3323'
  accent-rank: '#ffaa3b'
  hairline: '#ededed'
  border-medium: '#b3b3b3'
typography:
  heading:
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.41
    use: Search suggest titles, headings
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.33
    use: Product list items, UI labels
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Captions, metadata
  badge:
    fontSize: 12px
    fontWeight: 400
    use: Badges
  micro:
    fontSize: 11px
    fontWeight: 400
    use: Heat/rank metadata labels
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
components:
  header-bar:
    type: card
    backgroundColor: '#d62872'
    textColor: '#ffffff'
    height: 44px
    typography: 26px / 700
    use: Primary header bar
  cart-badge:
    type: badge
    backgroundColor: '#e5047e'
    textColor: '#ffffff'
    rounded: 8px
    typography: 12px / 400
    use: Cart notification badge
  input:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #b3b3b3'
    height: 36px
    padding: 8px 8px 8px 10px
    rounded: 4px
    typography: 15px / 400
    use: Search input desktop
  chip:
    type: badge
    backgroundColor: '#f2f2f2'
    textColor: '#404040'
    height: 32px
    rounded: 16px
    padding: 6px 8px
    typography: 13px / 400
    use: Recent/suggest search chip
  button-primary:
    type: button
    backgroundColor: '#d62872'
    textColor: '#ffffff'
    height: 38px
    rounded: 4px
    typography: 16px / 700
    states: 'hover #d9006c'
    use: Primary CTA
  button-destructive:
    type: button
    backgroundColor: '#ea3323'
    textColor: '#ffffff'
    height: 44px
    rounded: 22px
    typography: 17px / 400
    use: Delete all action
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#999999'
    border: '1px solid #b3b3b3'
    rounded: 13px
    padding: 3px 5px 3px 8px
    typography: 13px / 400
    use: Secondary rules button
  trend-card:
    type: card
    backgroundColor: linear-gradient(180deg,#fff5f9,#f9f9f9)
    border: '1px solid #fbe9f1'
    rounded: 15px
    use: Search trend card
  rank-badge:
    type: badge
    backgroundColor: linear-gradient(0.34deg,#ffaa3b,#ff9203)
    textColor: '#ffffff'
    rounded: 4px
    typography: 15px / 400
    use: Top rank number badge
  tooltip:
    type: card
    backgroundColor: rgba(0,0,0,.8)
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px
    typography: 15px / 700
    use: Search dialog tooltip
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Microsoft JhengHei UI
    mono: Oxygen
---

# momo購物網

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to momo購物網; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/momoshop/DESIGN.md
