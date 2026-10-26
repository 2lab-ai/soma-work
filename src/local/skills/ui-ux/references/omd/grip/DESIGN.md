---
name: Grip
colors:
  primary: '#eb2b51'
  hot-pink: '#ff3c78'
  purple: '#6456dc'
  canvas: '#0e1011'
  surface-1: '#17181a'
  surface-2: '#222327'
  surface-3: '#404149'
  surface-light: '#ffffff'
  surface-subtle: '#f3f3f3'
  text-primary: '#eff0f4'
  text-body: '#323232'
  text-muted: '#999999'
  text-subdued: '#666666'
  border: '#e5e5e5'
  border-subtle: '#d5d5d5'
  error: '#ef4343'
typography:
  discount:
    fontSize: 27px
    fontWeight: 700
    lineHeight: 1.35
    use: Discount price, coupon amount
  confirm:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.4
    use: Full-width confirm button
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Primary button label
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.4
    use: Body, product name
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Caption, meta
  badge:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    use: Badge, tag
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  section: 56
components:
  button-primary:
    type: button
    backgroundColor: '#eb2b51'
    textColor: '#ffffff'
    rounded: 8px
    typography: 16px / 600
    use: Primary CTA / cart checkout, 50px height
  button-confirm:
    type: button
    backgroundColor: '#eb2b51'
    textColor: '#ffffff'
    rounded: 8px
    typography: 18px / 500
    use: Full-width drawer-bottom confirm, 56px height
  button-secondary:
    type: button
    backgroundColor: '#323232'
    textColor: '#ffffff'
    rounded: 4px
    typography: 14px / 500
    use: Dark secondary buy-now inline, 34px height
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#323232'
    rounded: 4px
    typography: 14px / 500
    use: 'Outline delete / cancel, 1px #e5e5e5 border, 34px height'
  button-discovery:
    type: button
    backgroundColor: '#17181a'
    textColor: '#ffffff'
    rounded: 6px
    typography: 15px / 600
    use: Shorts / discovery CTA, 40px height
  card-coupon:
    type: card
    backgroundColor: '#fff5f8'
    textColor: '#eb2b51'
    typography: 27px / 700
    use: Active coupon card, rose-red amount
  nudge-urgency:
    type: toast
    backgroundColor: rgba(47,23,253,0.05)
    textColor: '#6456dc'
    rounded: 4px
    typography: 14px / 500
    use: Urgency countdown nudge bar, 38px height
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# Grip

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Grip; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/grip/DESIGN.md
