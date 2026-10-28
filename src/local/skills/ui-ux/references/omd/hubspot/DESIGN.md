---
name: HubSpot
colors:
  primary: '#ff4800'
  primary-tint: '#fcded2'
  canvas: '#fcfcfa'
  warm-parchment: '#f8f5ee'
  ink: '#1f1f1f'
  deep-teal: '#042729'
  graphite: '#60605f'
  mist: '#cacac8'
  on-primary: '#ffffff'
  cadet-navy: '#15295a'
typography:
  display-hero:
    fontSize: 80px
    fontWeight: 500
    lineHeight: 1.19
    use: Hero display — HubSpot Serif Page Header Human
  heading-xl:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.1
    use: Large section headlines — HubSpot Serif
  heading-lg:
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.15
    use: Section headings — HubSpot Serif
  heading:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.42
    use: Card headings — HubSpot Sans
  heading-sm:
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.45
    use: Sub-section heads — HubSpot Sans
  subheading:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.67
    use: Feature descriptions
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.56
    use: Standard reading text
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Secondary UI text, labels
  caption:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.6
    use: Small labels, eyebrows
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1
    use: Primary button label
  button-sm:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    use: Small button label
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
    backgroundColor: '#ff4800'
    textColor: '#ffffff'
    rounded: 8px
    padding: 16px 40px
    typography: 18px / 500 HubSpot Sans
    border: 2px solid rgba(0,0,0,0)
    states: hover darken
    use: Primary CTA — Get a demo / Get started
  button-outlined:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#ff4800'
    rounded: 8px
    padding: 16px 40px
    typography: 18px / 500 HubSpot Sans
    border: '2px solid #ff4800'
    use: Secondary CTA — Get started free
  button-dark:
    type: button
    backgroundColor: '#1f1f1f'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 16px
    typography: 14px / 500 HubSpot Sans
    use: Dark surface CTA — Learn more
  button-sm:
    type: button
    backgroundColor: '#ff4800'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 16px
    typography: 14px / 500 HubSpot Sans
    use: Compact primary button
  input-default:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #cacac8'
    rounded: 4px
    textColor: '#1f1f1f'
    typography: 16px HubSpot Sans
    use: Standard text/email input
  card-product:
    type: card
    backgroundColor: '#fcfcfa'
    textColor: '#1f1f1f'
    rounded: 16px
    border: 2px solid rgba(0,0,0,0.11)
    padding: 24px
    use: Product hub overview card
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1f1f1f'
    rounded: 16px
    border: '1px solid #1f1f1f'
    padding: 24px 32px
    use: Feature content card with hairline border
  badge-default:
    type: badge
    backgroundColor: '#fcded2'
    textColor: '#ff4800'
    rounded: 4px
    padding: 4px 8px
    typography: 12px / 500 HubSpot Sans
    use: Warm peach accent pill / tag
  tab-filter:
    type: tab
    backgroundColor: '#f8f5ee'
    textColor: '#1f1f1f'
    rounded: 16px
    typography: 14px / 500 HubSpot Sans
    active: 'text #1f1f1f bg #f8f5ee'
    use: Filter tab (By Use Case / By Team Size)
fonts:
  roles:
    sans: HubSpot Sans
    serif: HubSpot Serif
    fallback-sans: Inter
    fallback-serif: Source Serif 4
---

# HubSpot

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to HubSpot; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/hubspot/DESIGN.md
