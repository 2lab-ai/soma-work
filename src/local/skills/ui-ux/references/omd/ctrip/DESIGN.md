---
name: Ctrip
colors:
  brand: '#006ff6'
  brand-hover: '#2582f5'
  brand-border: '#93bff5'
  brand-tint: '#ebf4ff'
  brand-tint-low: '#f5f9ff'
  foreground: '#111111'
  text-secondary: '#555555'
  text-muted: '#aaaaaa'
  border: '#d5d5d5'
  surface: '#f5f5f5'
  surface-secondary: '#f5f7fa'
  bluegray-mid: '#869ebf'
  bluegray-line: '#e1e7f0'
  canvas: '#ffffff'
  on-brand: '#ffffff'
  notice: '#ff7700'
  notice-strong: '#ff5500'
  notice-tint: '#fff4eb'
  success: '#06875a'
  success-icon: '#24b281'
  success-border: '#8dd9be'
  favorite: '#f5190a'
  star-rating: '#fcb000'
typography:
  base:
    fontSize: 14px
    use: Dominant reading size — 817 of ~2,000 sampled elements
  caption:
    fontSize: 12px
    use: Metadata and secondary labels
  control:
    fontSize: 16px
    use: Search field and primary control text
  lead:
    fontSize: 20px
    use: Section lead
  sub:
    fontSize: 18px
    use: Sub-heading
  display:
    fontSize: 24px
    use: Largest repeated step
rounded:
  sm: 4px
  md: 8px
  pill: 16px
  tab: 20px
components:
  button-search:
    type: button
    backgroundColor: '#006ff6'
    textColor: '#ffffff'
    rounded: 4px
    typography: 16px / 700
    hover: '#2953d6'
    pressed: '#2953d6'
    use: Primary search submit on hotels.ctrip.com — 48px tall. Rest equals coreColorBlue1; the hover value is not a published token.
    padding: 0px 16px
    focus: 'shadow #ffffff 0px 0px 0px 2px, #1733c5 0px 0px 0px 4px on :focus-visible'
  button-login-pill:
    type: button
    backgroundColor: '#f2f8fe'
    textColor: '#333333'
    rounded: 16px
    typography: 14px / 400
    hover: '#0086f6'
    pressed: '#0086f6'
    focus: '#0086f6'
    use: Header sign-in pill — 32px tall; hover, press and focus all recolour text and border together.
  chip-city:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 4px
    typography: 14px / 400
    hover: '#0086f6'
    use: Departure-city chip in the search panel — 34px tall; hover recolours the label only.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# Ctrip

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ctrip; reproduced for educational reference. Full prose: https://oh-my-design.kr/ctrip/design.md
