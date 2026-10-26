---
name: iCHEF
colors:
  primary: '#e8552d'
  primary-hover: '#d14a26'
  accent-tint: '#fdede7'
  canvas: '#ffffff'
  surface: '#f7f7f7'
  surface-hover: '#efefef'
  foreground: '#1f1f1f'
  body: '#555555'
  muted: '#888888'
  disabled: '#bcbcbc'
  hairline: '#e6e6e6'
  border: '#d4d4d4'
  success: '#1fa463'
  warning: '#f5a623'
  error: '#e0353b'
  info: '#2b82e0'
typography:
  hero:
    fontSize: 34px
    fontWeight: 700
    lineHeight: 1.15
    use: Marketing hero headline
  heading:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.25
    use: Card / section headings
  total:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.2
    use: Totals, table numbers (scannable)
  pos-tile:
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.3
    use: POS button / menu item, large tap text
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Body, descriptions
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.2
    use: Button labels
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Caption, metadata
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 48
  xxl: 80
components:
  button-primary:
    type: button
    backgroundColor: '#e8552d'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 24px
    typography: 16px / 600
    hover: 'bg #d14a26'
    use: Primary CTA / key POS action
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1f1f1f'
    border: '1px solid #d4d4d4'
    rounded: 8px
    padding: 12px 24px
    typography: 16px / 600
    hover: 'bg #f7f7f7'
    use: Secondary actions
  pos-tile:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1f1f1f'
    rounded: 8px
    padding: 12px
    typography: 16px / 600
    active: 'bg #fdede7, 1px solid #e8552d'
    use: Tappable menu-item grid in order screen
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1f1f1f'
    border: '1px solid #d4d4d4'
    rounded: 8px
    padding: 12px 14px
    typography: 16px / 400
    focus: 'border #e8552d'
    states: 'error border #e0353b'
    use: Forms, menu editing, settings
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e6e6e6'
    rounded: 8px
    padding: 24px
    use: Feature explainers, plan cards
  card-order:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 12px
    use: Open-table / order tickets with status-tinted left border
  badge-status:
    type: badge
    backgroundColor: '#1fa463'
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 8px
    typography: 12px / 600
    states: 'pending #f5a623, void #e0353b'
    use: Order/payment status
fonts:
  roles:
    sans: PingFang TC
    mono: SFMono-Regular
---

# iCHEF

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to iCHEF; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/ichef/DESIGN.md
