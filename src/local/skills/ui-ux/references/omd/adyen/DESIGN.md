---
name: Adyen
colors:
  brand: '#00d16a'
  primary: '#001222'
  foreground: '#001222'
  navy-2800: '#1a2b3b'
  navy-2500: '#2f3e4d'
  slate: '#636f7a'
  grey-1400: '#848d96'
  grey-500: '#d1d5d8'
  grey-200: '#ecedef'
  grey: '#f4f5f6'
  sand: '#e6e4e2'
  sand-light: '#f6f5f4'
  canvas: '#ffffff'
  blue: '#0063d7'
  purple: '#cb96ff'
  yellow: '#ffc200'
  orange: '#ff9e11'
  red: '#c72727'
rounded:
  base: 6px
  lg: 24px
components:
  button-cta:
    type: button
    backgroundColor: '#00d16a'
    textColor: '#001222'
    rounded: 6px
    typography: Adyen
    hover: '::before overlay rgba(0,18,34,0.074)'
    focus: 'outline 1px solid #ffffff'
    use: Contact us in the header — green with a navy label. Hover fades in a ::before overlay of --main-light-secondary (navy at 7.4%) over the green; focus draws a 1px white outline.
    height: 48px
    padding: 0px 16px
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    hover: transparent
    focus: 'outline 1px solid #ffffff'
    use: Pricing in the header over the dark hero — hover changes nothing (pseudo-elements included); focus draws the same 1px white outline.
omitted:
  - section: typography
    reason: No verified values in current evidence.
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Adyen
    mono: Adyen Mono
---

# Adyen

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Adyen; reproduced for educational reference. Full prose: https://oh-my-design.kr/adyen/design.md
