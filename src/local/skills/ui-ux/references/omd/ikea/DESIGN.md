---
name: IKEA
colors:
  brand-blue: '#0058a3'
  brand-yellow: '#ffdb00'
  primary: '#111111'
  primary-hover: '#333333'
  emphasised-hover: '#004f93'
  emphasised-pressed: '#003e72'
  foreground: '#484848'
  text-3: '#767676'
  text-4: '#929292'
  secondary-bg: '#f5f5f5'
  secondary-hover: '#dfdfdf'
  secondary-pressed: '#cccccc'
  canvas: '#ffffff'
  family-blue: '#007cc1'
  offer-red: '#cc0008'
  negative: '#e00751'
  positive: '#0a8a00'
  caution: '#f26a2f'
typography:
  nav:
    fontSize: 14px
    fontWeight: 400
    use: header links
  input:
    fontSize: 16px
    fontWeight: 400
    use: search field
rounded:
  sm: 4px
  pill: 64px
components:
  link-header:
    type: button
    backgroundColor: transparent
    textColor: '#484848'
    rounded: 0px
    height: 46px
    padding: 12px 16px
    typography: 14px / 400
    hover: 'fg #111111 + underline'
    pressed: 'fg #111111 + underline'
    focus: 'box-shadow 0 0 0 4px #ffffff + outline 2px solid #111111'
    use: 'Produkte in the header — the grey text darkens to #111111 and underlines on hover; focus adds a white 4px ring inside a 2px #111111 outline.'
  input-search:
    type: input
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 0px
    height: 48px
    padding: 0 0 0 48px
    typography: 16px / 400
    hover: transparent
    focus: transparent
    use: The header search field (search@11). The input itself shows no change on hover or focus; its frame belongs to the wrapping search component, which was not read.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Noto IKEA
---

# IKEA

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to IKEA; reproduced for educational reference. Full prose: https://oh-my-design.kr/ikea/design.md
