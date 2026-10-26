---
name: MUJI
colors:
  primary: '#333333'
  primary-hover: '#000000'
  brand: '#7f0019'
  brand-hover: '#6b0015'
  canvas: '#ffffff'
  surface: '#f7f7f7'
  foreground: '#333333'
  muted: '#666666'
  on-primary: '#ffffff'
  hairline: '#dddddd'
  border-strong: '#cccccc'
  error: '#c0392b'
  success: '#4a7c59'
typography:
  page-title:
    fontSize: 28px
    fontWeight: 300
    lineHeight: 1.4
    letterSpacing: 0.02px
    use: Quiet authority page title
  section:
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.02px
    use: Category / section titles
  subheading:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.02px
    use: Card titles, group labels
  lead:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 1.7
    letterSpacing: 0.02px
    use: Editorial intro paragraphs
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: 0.02px
    use: Standard reading text
  body-small:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0.02px
    use: Product descriptions, dense copy
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.04px
    use: Metadata, legal, breadcrumbs
  price:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.3
    use: Product price
  button:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: 0.04px
    use: Add to cart, primary actions
rounded:
  sm: 2px
  md: 2px
  lg: 2px
  full: 9999px
components:
  button-primary:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 2px
    padding: 14px 24px
    typography: 14px / 400
    states: 'hover #000000'
    use: Single primary action (add to cart / checkout)
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #333333'
    rounded: 2px
    padding: 13px 24px
    typography: 14px / 400
    states: 'hover bg #f7f7f7'
    use: Secondary actions
  button-tertiary:
    type: button
    backgroundColor: transparent
    textColor: '#666666'
    border: '1px solid #dddddd'
    rounded: 2px
    padding: 10px 16px
    typography: 13px / 400
    use: Low-priority actions, filters
  button-brand:
    type: button
    backgroundColor: '#7f0019'
    textColor: '#ffffff'
    rounded: 2px
    padding: 14px 24px
    typography: 14px / 400
    states: 'hover #6b0015'
    use: Sale / campaign CTAs only
  button-disabled:
    type: button
    backgroundColor: '#eeeeee'
    textColor: '#999999'
    rounded: 2px
    use: Out-of-stock, unavailable
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #cccccc'
    rounded: 2px
    padding: 12px 14px
    typography: 14px / 400
    focus: 'border #333333, no glow'
    use: Standard form field
  input-error:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #c0392b'
    rounded: 2px
    use: 'Validation failure, help text #c0392b'
  card-product:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: '0'
    shadow: none
    use: Catalog grid card, photo is the card
  card-editorial:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #eeeeee'
    rounded: 2px
    padding: 20px
    shadow: none
    use: Story modules, info panels
  tag-sale:
    type: badge
    backgroundColor: '#7f0019'
    textColor: '#ffffff'
    rounded: 0px
    padding: 2px 8px
    typography: 11px / 400
    use: Sale indicator, printed-label feel
  tag-neutral:
    type: badge
    backgroundColor: '#eeeeee'
    textColor: '#666666'
    rounded: 0px
    padding: 2px 8px
    typography: 11px / 400
    use: NEW, category labels
  tab:
    type: tab
    textColor: '#999999'
    typography: 14px / 400
    active: 'text #333333, 2px bottom border #333333'
    use: PDP detail tabs, category switching
  segmented:
    type: tab
    backgroundColor: '#eeeeee'
    rounded: 2px
    typography: 13px / 400
    active: 'bg #ffffff, text #333333'
    use: View toggles, sort modes
  toast:
    type: toast
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 2px
    padding: 12px 16px
    shadow: 0 2px 8px rgba(0,0,0,0.12)
    typography: 13px / 400
    use: Transient confirmation
  notice-inline:
    type: card
    backgroundColor: '#f7f7f7'
    textColor: '#333333'
    border: '2px solid #7f0019'
    rounded: 0px
    padding: 12px 16px
    use: Shipping info, stock notices
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 2px
    padding: 32px
    shadow: 0 4px 24px rgba(0,0,0,0.16)
    use: Confirmation, size guide, login
  checkbox:
    type: toggle
    border: '1px solid #cccccc'
    rounded: 2px
    active: '#333333 fill, white check'
    use: Filters, terms agreement, square
  toggle:
    type: toggle
    backgroundColor: '#cccccc'
    rounded: 9999px
    active: 'track #333333, white thumb'
    use: Newsletter / setting switches
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Helvetica Neue
    mono: Helvetica Neue
---

# MUJI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MUJI; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/muji/DESIGN.md
