---
name: KKday
colors:
  primary: '#ff5c00'
  primary-hover: '#e65300'
  brand: '#ff5c00'
  canvas: '#ffffff'
  foreground: '#1a1a1a'
  muted: '#888888'
  on-primary: '#ffffff'
  surface: '#f7f7f8'
  hairline: '#e5e5e6'
  border-mid: '#d9d9d9'
  body: '#4a4a4a'
  brand-tint: '#fff0e8'
  success: '#1fa463'
  warning: '#f5a623'
  error: '#e0353b'
  rating: '#ffb400'
typography:
  hero:
    fontSize: 32px
    fontWeight: 700
    use: Hero headline
  section-heading:
    fontSize: 23px
    fontWeight: 700
    use: Section heading
  card-heading:
    fontSize: 19px
    fontWeight: 700
    use: Card heading
  price:
    fontSize: 18px
    fontWeight: 700
    use: Price, prominent bold
  body:
    fontSize: 15px
    fontWeight: 400
    use: Body, card title
  body-small:
    fontSize: 13px
    fontWeight: 400
    use: Location label, secondary
  caption:
    fontSize: 12px
    fontWeight: 400
    use: Caption, meta
rounded:
  sm: 4px
  md: 8px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 40
  xxl: 64
components:
  button-primary:
    type: button
    backgroundColor: '#ff5c00'
    textColor: '#ffffff'
    rounded: 8px
    padding: 10px 20px
    typography: 16px / 600
    hover: '#e65300'
    use: Book Now, Add to Cart, primary conversion CTA
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    border: '1px solid #d9d9d9'
    rounded: 8px
    padding: 10px 20px
    typography: 16px / 600
    hover: '#f7f7f8'
    use: View Details, secondary actions
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#ff5c00'
    rounded: 8px
    padding: 8px 12px
    use: Inline tertiary actions, See more
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    border: '1px solid #d9d9d9'
    rounded: 8px
    padding: 10px 14px
    typography: 16px / 400
    focus: 'border #ff5c00'
    states: 'error border #e0353b'
    use: Search, traveler details, contact forms
  card-experience:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e5e5e6'
    rounded: 8px
    padding: '0'
    use: Grid product card, image-led with title/rating/price/trust chips
  badge-sale:
    type: badge
    backgroundColor: '#ff5c00'
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 6px
    typography: 12px / 700
    use: Discount/sale ribbon on product image
  badge-trust:
    type: badge
    backgroundColor: '#fff0e8'
    textColor: '#1fa463'
    rounded: 4px
    padding: 2px 8px
    typography: 12px / 500
    use: Instant confirmation, Free cancellation
  badge-urgency:
    type: badge
    backgroundColor: transparent
    textColor: '#f5a623'
    typography: 12px / 600
    use: Only 2 left, Selling fast
  tab-nav:
    type: tab
    textColor: '#1a1a1a'
    typography: 15px / 500
    active: 'orange #ff5c00 active/hover accent'
    use: Sticky header nav links
fonts:
  roles:
    sans: '-apple-system'
    mono: SF Mono
---

# KKday

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KKday; reproduced for educational reference. Full prose: https://oh-my-design.kr/kkday/design.md
