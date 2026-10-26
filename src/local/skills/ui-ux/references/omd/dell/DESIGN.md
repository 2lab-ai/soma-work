---
name: Dell
colors:
  primary: '#0076CE'
  primary-hover: '#0063AF'
  primary-active: '#00538F'
  blue-tint: '#E5F1FA'
  canvas: '#ffffff'
  band: '#F7F8FA'
  heading: '#11141a'
  navy: '#0E1B2C'
  body: '#4C545E'
  caption: '#6B7480'
  placeholder: '#9AA3AE'
  label: '#22262B'
  border: '#DDE1E6'
  border-strong: '#C5CBD3'
  fill: '#EEF0F3'
  success: '#008A00'
  success-bg: '#E6F4E6'
  error: '#CE2029'
  warning: '#B85C00'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.17
    letterSpacing: '-0.5px'
    use: Marketing hero headlines
  display-lg:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: '-0.25px'
    use: Landing section headers
  h1:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    use: Page titles, PDP product name
  h2:
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.36
    use: Section headings, card titles
  h3:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.44
    use: Sub-sections, spec group labels
  subtitle:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: List headers, emphasized labels
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Descriptions, marketing copy
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Standard reading text, spec rows
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Secondary info, table cells
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0.2px
    use: Legal, fine print, timestamps
  price:
    fontSize: 28px
    fontWeight: 700
    use: Product price, tabular numerals
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
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#0076CE'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 24px
    typography: 14px/500 Roboto
    use: Primary commerce CTA (Add to Cart, Buy Now)
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0076CE'
    rounded: 4px
    padding: 0 24px
    typography: 14px/500 Roboto
    use: Secondary action (Compare, Learn More)
  button-tertiary:
    type: button
    backgroundColor: transparent
    textColor: '#0076CE'
    rounded: 4px
    padding: 0 8px
    typography: 14px/500 Roboto
    use: Low-emphasis inline action (View details, Remove)
  button-dark:
    type: button
    backgroundColor: '#11141a'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 24px
    typography: 14px/500 Roboto
    use: High-contrast marketing CTA
  button-danger:
    type: button
    backgroundColor: '#CE2029'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 24px
    typography: 14px/500 Roboto
    use: Destructive confirmation
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#22262B'
    rounded: 4px
    padding: 10px 12px
    typography: 14px/400 Roboto
    use: Standard form input
  product-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 16px
    use: Grid product tile
  promo-card:
    type: card
    backgroundColor: '#0E1B2C'
    textColor: '#ffffff'
    rounded: 8px
    padding: 24px
    use: Dark promotional banner card
  badge-deal:
    type: badge
    backgroundColor: '#CE2029'
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/700 Roboto
    use: Save $X, Clearance, Doorbuster
  badge-instock:
    type: badge
    backgroundColor: '#E6F4E6'
    textColor: '#008A00'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/500 Roboto
    use: Availability indicator
  badge-new:
    type: badge
    backgroundColor: '#E5F1FA'
    textColor: '#0076CE'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/700 Roboto
    use: Newly released product
  badge-neutral:
    type: badge
    backgroundColor: '#EEF0F3'
    textColor: '#4C545E'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/500 Roboto
    use: Category tags, metadata chips
  tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#6B7480'
    typography: 14px/500 Roboto
    active: '2px bottom border #0076CE, text #11141a'
    use: PDP sections, account dashboard
  toast:
    type: toast
    backgroundColor: '#11141a'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 16px
    typography: 14px/400 Roboto
    use: Transient confirmation
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#11141a'
    rounded: 8px
    padding: 24px
    use: Configuration confirm, cart review, sign-in
  toggle:
    type: toggle
    backgroundColor: '#0076CE'
    rounded: 9999px
    use: 'Boolean preferences (on track blue, off #C5CBD3)'
fonts:
  roles:
    sans: Roboto
    mono: Roboto Mono
---

# Dell

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Dell; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/dell/DESIGN.md
