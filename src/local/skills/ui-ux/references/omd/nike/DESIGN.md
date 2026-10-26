---
name: Nike
colors:
  ink: '#111111'
  canvas: '#ffffff'
  volt: '#d8ff00'
  volt-ui: '#cdfb40'
  orange-heritage: '#fa5400'
  sale: '#d43f21'
  error: '#e34f2b'
  success: '#0a8800'
  info: '#1463ff'
  warning: '#cd7b00'
  grey-50: '#f7f7f7'
  grey-100: '#f5f5f5'
  grey-200: '#e5e5e5'
  grey-300: '#cccccc'
  grey-500: '#8d8d8d'
  grey-600: '#757575'
  grey-700: '#707072'
typography:
  hero:
    fontSize: 80px
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: '-0.01em'
    use: Hero headline, UPPERCASE condensed
  display-lg:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.01em'
    use: Section banners (JUST IN)
  display-md:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.05
    use: Editorial sub-headers
  h1:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.2
    use: Product title (PDP)
  h2:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.25
    use: Card / section titles
  subtitle:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: Product category, list headers
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Descriptions, paragraphs
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  price:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.4
    use: Price; sale price in red
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Metadata, color count
  label:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0.04em
    use: UPPERCASE micro-labels
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
  xl: 32
components:
  button-primary:
    type: button
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 0 24px
    typography: 16px/500
    use: Add to Bag, Checkout on white
  button-inverted:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 9999px
    padding: 0 24px
    typography: 16px/500
    use: Primary CTA on dark sections
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 9999px
    padding: 0 24px
    typography: 16px/500
    use: Secondary outline action
  button-volt:
    type: button
    backgroundColor: '#d8ff00'
    textColor: '#111111'
    rounded: 9999px
    padding: 0 24px
    typography: 16px/700
    use: Energy CTA, drops/SNKRS
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 8px
    padding: 14px 16px
    typography: 16px/400
    use: Form / checkout field
  input-search:
    type: input
    backgroundColor: '#f5f5f5'
    textColor: '#111111'
    rounded: 9999px
    padding: 12px 20px
    typography: 16px/400
    use: Header search field
  product-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 0px
    use: Grid PLP product tile
  surface-card:
    type: card
    backgroundColor: '#f7f7f7'
    rounded: 12px
    padding: 24px
    use: Member panels, bag summary
  promo-pill:
    type: badge
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 4px 12px
    typography: 12px/700
    use: MEMBER ACCESS tags
  sale-pill:
    type: badge
    backgroundColor: '#d43f21'
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/700
    use: Discount flag on imagery
  filter-chip:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 9999px
    padding: 8px 16px
    typography: 15px/400
    use: PLP filter row
    active: 'filled #111111 bg, #ffffff text'
  toast:
    type: toast
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 8px
    padding: 16px 20px
    use: Cart confirmation, favorite saved
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 12px
    padding: 32px
    use: Size guide, quick add, login wall
fonts:
  roles:
    sans: Helvetica Now Text
    mono: Helvetica Now Text
---

# Nike

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Nike; reproduced for educational reference. Full prose: https://oh-my-design.kr/nike/design.md
