---
name: Mistral AI
colors:
  foreground: '#000000'
  border: '#e4e3de'
  surface-brand-secondary: '#f5f4ef'
  surface-brand-primary: '#fbfbf8'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Public-site body, list, card, and product-pricing copy
  control:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0.16px
    use: Header controls and compact links
  display:
    fontSize: 56px
    fontWeight: 500
    lineHeight: 1.07
    letterSpacing: '-0.56px'
    use: Observed large public-marketing headings
  eyebrow:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.45
    use: Small uppercase label on the public marketing surface
rounded:
  sharp: 0px
  sm: 4px
  md: 6px
  lg: 8px
spacing:
  xs: 2
  sm: 4
  md: 8
  lg: 16
  xl: 24
components:
  pricing-plan:
    type: card
    backgroundColor: '#fbfbf8'
    textColor: '#000000'
    border: '1px solid #e4e3de'
    rounded: 0px
    typography: 16px / 400 / Inter
    use: Pricing-plan shell
  disabled-compact-control:
    type: button
    backgroundColor: rgba(7, 7, 11, 0.1)
    textColor: oklch(0.552 0.016 285.938)
    rounded: 6px
    padding: 4px
    typography: 16px / 400 / Inter
    states: disabled DOM state observed
    use: Disabled compact pricing control
fonts:
  roles:
    ui: Inter
    display: ALTMistral
    mono: Space Mono
---

# Mistral AI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Mistral AI; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/mistral.ai/DESIGN.md
