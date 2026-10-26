---
name: Uniqlo
colors:
  primary: '#ed1d24'
  primary-hover: '#c8161c'
  canvas: '#ffffff'
  heading: '#1a1a1a'
  body: '#333333'
  secondary: '#666666'
  muted: '#999999'
  error: '#d0021b'
  success: '#1a8917'
  info: '#0070c9'
  gray-50: '#f5f5f5'
  gray-100: '#eeeeee'
  gray-300: '#cccccc'
  border: '#e0e0e0'
  border-strong: '#1a1a1a'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.5px'
    use: Campaign headlines, hero
  display-lg:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.3px'
    use: Feature section heads
  heading-1:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.2
    use: Page titles, category heads
  heading-2:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.25
    use: Sub-section titles
  subtitle:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Product names in tiles
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard catalog text
  price:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.2
    use: Product price, tabular numerals
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Metadata, fine print
  label:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.5px
    use: Uppercase tags NEW/SALE
rounded:
  sm: 2px
  md: 2px
  lg: 4px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#ed1d24'
    textColor: '#ffffff'
    rounded: 2px
    padding: 14px 24px
    typography: 15px/700
    use: 'Primary CTA ADD TO CART; hover #c8161c'
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 2px
    padding: 14px 24px
    use: 'Outlined; 1px #1a1a1a border, hover inverts to #1a1a1a'
  button-solid-black:
    type: button
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 2px
    padding: 14px 24px
    use: 'Neutral strong action; hover #333333'
  button-disabled:
    type: button
    backgroundColor: '#eeeeee'
    textColor: '#999999'
    rounded: 2px
    use: Unavailable action
  product-tile:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: 8px
    use: Atomic product tile, grid-gutter separated, no shadow
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 2px
    padding: 12px 14px
    typography: 14px
    use: 'Text input; 1px #cccccc border, focus #1a1a1a'
  size-chip:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 2px
    padding: 8px 14px
    use: 'Size selector; 1px #cccccc border, selected 2px #1a1a1a'
  sale-flag:
    type: badge
    backgroundColor: '#ed1d24'
    textColor: '#ffffff'
    rounded: 0px
    padding: 2px 6px
    typography: 11px/700
    use: SALE/LIMITED uppercase flag
fonts:
  roles:
    sans: TT Commons Pro
    mono: Helvetica Neue
---

# Uniqlo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Uniqlo; reproduced for educational reference. Full prose: https://oh-my-design.kr/uniqlo/design.md
