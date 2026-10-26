---
name: PayFit
colors:
  brand: '#f048f0'
  brand-active: '#d100d1'
  highlight-hover: '#ffc7ff'
  highlight-pressed: '#ff7aff'
  plum: '#7f007f'
  primary: '#0d0d0c'
  primary-hover: '#333332'
  foreground: '#0d0d0c'
  text-secondary: '#5c5957'
  placeholder: '#706e6b'
  surface: '#f5f5f4'
  surface-alt: '#f1f0ef'
  border: '#e7e6e4'
  canvas: '#ffffff'
  focus: '#0d9ad8'
  danger: '#b52834'
  card-blue: '#9fdff9'
  card-yellow: '#f7e98d'
typography:
  button:
    fontSize: 16px
    fontWeight: 500
    use: calls to action
  nav:
    fontSize: 16px
    fontWeight: 400
    use: header navigation
rounded:
  sm: 6px
  md: 8px
components:
  button-primary:
    type: button
    backgroundColor: '#0d0d0c'
    textColor: '#ffffff'
    rounded: 8px
    height: 48px
    padding: 12px 16px
    typography: 16px / 500
    hover: '#333332'
    focus: 'outline 2px solid #0d9ad8'
    use: 'Essayez maintenant — near-black, lifting to #333332 on hover; press returns to the rest colour (--uy-color-surface-button-primary-pressed). Focus is a 2px blue outline.'
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0d0d0c'
    border: '#5c5957'
    rounded: 8px
    height: 48px
    typography: 16px / 500
    hover: '#f5f5f4'
    pressed: 'border #0d0d0c'
    focus: 'outline 2px solid #0d9ad8'
    use: 'Demandez une démo — white with a #5c5957 border; hover fills --uy-color-surface-button-secondary-hover #f5f5f4 and darkens the border to #0d0d0c.'
  nav-item:
    type: button
    backgroundColor: transparent
    textColor: '#0d0d0c'
    border: '#e7e6e4'
    rounded: 6px
    height: 39px
    padding: 10px
    typography: 16px / 400
    hover: '#f1f0ef'
    pressed: '#f1f0ef'
    use: 'Pourquoi Payfit ?, Solution, Produit … — header items that fill with warm grey #f1f0ef on hover and press. Focus is the browser''s ring.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Restart Soft
    display: Heartbreak Eighties
---

# PayFit

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PayFit; reproduced for educational reference. Full prose: https://oh-my-design.kr/payfit/design.md
