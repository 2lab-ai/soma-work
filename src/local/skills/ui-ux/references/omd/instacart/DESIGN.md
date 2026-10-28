---
name: Instacart
colors:
  primary: '#108910'
  primary-dark: '#003D29'
  primary-forest: '#1E6F30'
  on-primary: '#ffffff'
  ink: '#242529'
  ink-secondary: '#343538'
  canvas: '#ffffff'
  surface: '#F6F7F8'
  surface-alt: '#E8E9EB'
  hairline: '#C7C8CD'
  on-dark: '#ffffff'
typography:
  display-hero:
    fontSize: 26px
    fontWeight: 600
    lineHeight: 1.25
    use: Hero headline (viewport-width responsive)
  section:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.17
    use: Section headings
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body text
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Secondary body, card labels
  button:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Nav and hero CTA labels
  button-sm:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    use: Store-page CTAs, filter chips
rounded:
  sm: 4px
  md: 8px
  lg: 20px
  pill: 28px
  full: 999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#108910'
    textColor: '#ffffff'
    rounded: 28px
    padding: 0px 16px
    height: 56px
    typography: 16px / 400 Instacart Sans
    use: Hero CTA — Sign up, get $0 delivery fee
  button-nav:
    type: button
    backgroundColor: '#108910'
    textColor: '#ffffff'
    rounded: 20px
    padding: 0px 16px
    height: 40px
    typography: 16px / 400 Instacart Sans
    use: Nav Sign up button
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#242529'
    border: '1px solid #C7C8CD'
    rounded: 20px
    padding: 0px 16px
    height: 40px
    typography: 16px / 400 Instacart Sans
    use: Nav Log in button
  button-add:
    type: button
    backgroundColor: '#108910'
    textColor: '#ffffff'
    rounded: 20px
    height: 36px
    typography: 16px / 400 Instacart Sans
    use: Add to cart button on product cards
  button-dark:
    type: button
    backgroundColor: '#108910'
    textColor: '#ffffff'
    rounded: 24px
    padding: 8px 16px
    height: 48px
    typography: 14px / 600 Instacart Sans
    use: Store storefront Log in CTA
  filter-chip-active:
    type: badge
    backgroundColor: '#242529'
    textColor: '#ffffff'
    rounded: 999px
    padding: 0px 16px
    height: 32px
    typography: 14px / 600 Instacart Sans
    use: Active filter pill (All, selected state)
  filter-chip:
    type: badge
    backgroundColor: '#E8E9EB'
    textColor: '#242529'
    rounded: 999px
    padding: 0px 16px
    height: 32px
    typography: 14px / 600 Instacart Sans
    use: Inactive filter pill (EBT, Fastest, Grocery)
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#343538'
    border: '1px solid #C7C8CD'
    rounded: 28px
    padding: 0px 48px 0px 0px
    height: 56px
    typography: 15px / 400 Instacart Sans
    use: Main search input on homepage
  store-tab:
    type: tab
    textColor: '#343538'
    rounded: 20px
    typography: 16px / 400 Instacart Sans
    active: 'text #343538 + 2px border #343538'
    use: Delivery/Pickup tab selector on store pages
  card-surface:
    type: card
    backgroundColor: '#F6F7F8'
    rounded: 8px
    use: Light grey surface card for store listings and content blocks
fonts:
  roles:
    sans: Instacart Sans
    fallback: Instacart Sans Fallback, Arial, sans-serif
---

# Instacart

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Instacart; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/instacart/DESIGN.md
