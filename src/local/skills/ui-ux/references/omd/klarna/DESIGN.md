---
name: Klarna
colors:
  brand-pink: '#ffa8cd'
  primary: '#0b051d'
  foreground: '#0b051d'
  text-body: '#282636'
  text-subtle: '#504f5f'
  text-disabled: '#96959f'
  inverse: '#f9f8f5'
  hover: '#2c2242'
  accent: '#7039e2'
  accent-focus: '#7b57d8'
  link: '#582fb4'
  accent-subtle: '#efecff'
  border: '#e2e2e7'
  border-neutral: '#c4c3ca'
  pop: '#cff066'
  positive: '#046234'
  positive-badge: '#c1f4d1'
  negative: '#ae1d1d'
  warning: '#fbc64d'
  canvas: '#ffffff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: Klarna Text; the accordion items
  button:
    fontSize: 16px
    fontWeight: 500
    use: the pill button
  nav:
    fontSize: 13px
    fontWeight: 500
    use: header navigation
rounded:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  pill: 99999px
components:
  button-pill:
    type: button
    backgroundColor: '#0b051d'
    textColor: '#f9f8f5'
    border: '#e2e2e7'
    rounded: 99999px
    height: 42px
    padding: 11px 20px
    typography: 16px / 500
    hover: '#2c2242'
    pressed: '#2c2242'
    focus: 'outline 2px solid #0b051d'
    use: 'Logga in in the header — a near-black pill that lifts to --brand90 #2c2242 on hover and press; focus adds a 2px near-black outline.'
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#0b051d'
    rounded: 0px
    height: 24px
    padding: 4px 0
    typography: 13px / 500
    hover: opacity 0.84
    pressed: opacity 0.68
    focus: 'box-shadow inset 0 0 0 1px #7b57d8 + outline 2px solid #0b051d'
    use: Shoppa and the other header links — dim to 0.84 on hover and 0.68 on press; focus is a purple 1px inset ring inside a 2px near-black outline.
  accordion-item:
    type: button
    backgroundColor: transparent
    textColor: '#0b051d'
    rounded: 0px
    height: 64px
    typography: 16px / 400
    hover: opacity 0.84
    pressed: opacity 0.68
    focus: 'box-shadow 0 0 0 3px #7b57d8 + outline 2px solid #0b051d'
    use: An expandable item (Anpassat efter dig) — the same opacity steps, with a 3px purple ring on focus.
  input-search:
    type: input
    backgroundColor: transparent
    textColor: '#0b051d'
    rounded: 0px
    height: 22px
    typography: 14px / 400
    hover: transparent
    focus: transparent
    use: The header search field (Sök efter produkter…). None of its measured values change on hover or focus.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Klarna Text
    display: Klarna Title
---

# Klarna

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Klarna; reproduced for educational reference. Full prose: https://oh-my-design.kr/klarna/design.md
