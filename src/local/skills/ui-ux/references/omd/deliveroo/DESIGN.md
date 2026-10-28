---
name: Deliveroo
colors:
  primary: '#00CCBC'
  primary-hover: '#00A99C'
  primary-deep: '#003733'
  brand: '#00CCBC'
  canvas: '#ffffff'
  canvas-dark: '#121212'
  heading: '#1a1a1a'
  body: '#4a4a4a'
  muted: '#767676'
  on-primary: '#003733'
  promo: '#FFC100'
  promo-text: '#1a1a1a'
  error: '#DF1619'
  surface: '#f5f5f5'
  hairline: '#e0e0e0'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.5px'
    use: Hero headlines, Stratos Bold, 6° angled
  display-lg:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.3px'
    use: Section headlines
  section:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.2
    use: Sub-section heads, card titles
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Feature descriptions
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    use: CTA button label
  caption:
    fontSize: 14px
    fontWeight: 400
    use: Metadata, captions, secondary labels
  small:
    fontSize: 12px
    fontWeight: 400
    use: Tags, badges, fine print
rounded:
  sm: 4px
  md: 8px
  lg: 16px
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
    backgroundColor: '#00CCBC'
    textColor: '#003733'
    rounded: 9999px
    padding: 14px 24px
    typography: 16px / 600
    states: 'hover #00A99C'
    use: Primary CTA — Order now, Add to basket
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 9999px
    border: '1.5px solid #e0e0e0'
    padding: 14px 24px
    typography: 16px / 600
    use: Secondary action, ghost variant
  button-promo:
    type: button
    backgroundColor: '#FFC100'
    textColor: '#1a1a1a'
    rounded: 9999px
    padding: 14px 24px
    typography: 16px / 600
    use: Promotional offers and deals CTA
  input-search:
    type: input
    backgroundColor: '#f5f5f5'
    border: '1.5px solid #e0e0e0'
    rounded: 9999px
    padding: 12px 16px
    typography: 16px / 400
    use: Address / restaurant search input
  restaurant-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    shadow: 0px 2px 8px rgba(0,0,0,0.10)
    use: Restaurant listing card with hero image, name, rating, ETA
  promo-card:
    type: card
    backgroundColor: '#FFC100'
    textColor: '#1a1a1a'
    rounded: 8px
    use: Promotional deal card, gold background
  badge-status:
    type: badge
    backgroundColor: '#00CCBC'
    textColor: '#003733'
    rounded: 9999px
    padding: 4px 10px
    typography: 12px / 600
    use: Delivery ETA, order status pills
  badge-tag:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#1a1a1a'
    rounded: 9999px
    padding: 4px 10px
    typography: 12px / 400
    use: Restaurant category tags (Fast food, Asian, etc.)
  nav-tab:
    type: tab
    textColor: '#4a4a4a'
    rounded: 0px
    typography: 16px / 400
    active: 'text #00CCBC + 2px bottom border #00CCBC'
    use: Bottom navigation tabs (Home, Orders, Account)
  toggle-on:
    type: toggle
    backgroundColor: '#00CCBC'
    rounded: 9999px
    use: On state for dietary/preference filters
fonts:
  roles:
    display: Stratos
    body: system-ui, -apple-system, sans-serif
---

# Deliveroo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Deliveroo; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/deliveroo/DESIGN.md
