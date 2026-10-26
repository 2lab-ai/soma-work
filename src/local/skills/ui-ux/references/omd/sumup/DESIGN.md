---
name: SumUp
colors:
  brand: '#ff61f2'
  brand-hovered: '#eb58df'
  brand-pressed: '#da4ece'
  primary: '#1e1c1c'
  strong-hovered: '#3f3a3a'
  strong-pressed: '#756c6c'
  foreground: '#1e1c1c'
  text-subtle: '#706464'
  accent-hovered: '#726767'
  accent-pressed: '#887a7a'
  canvas: '#fbfbf9'
  surface: '#f5f4ed'
  subtle-hovered: '#f0eee7'
  subtle-pressed: '#e8e6dc'
  border: '#d0cdc3'
  border-hovered: '#ded7cf'
  border-subtle: '#e3e2d6'
  success: '#3c7411'
  success-strong: '#1e862d'
  danger: '#b13606'
  danger-strong: '#d23f04'
  warning: '#a65a03'
  promo: '#a33e9a'
  promo-strong: '#b342a9'
typography:
  body:
    fontSize: 17px
    use: SumUp Narrow; navigation and links at 375, buttons at 550
rounded:
  xs: 2px
  sm: 4px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-primary:
    type: button
    backgroundColor: '#1e1c1c'
    textColor: '#fbfbf9'
    rounded: 12px
    height: 68px
    padding: 11px 23px
    typography: 17px / 550
    hover: '#3f3a3a'
    pressed: '#756c6c'
    focus: 'ring 0 0 0 2px #fbfbf9, 0 0 0 4px #1e1c1c'
    use: 'Zum Warenkorb hinzufügen on a card-terminal page — --cui-bg-strong, lightening to --cui-bg-strong-hovered and -pressed. Focus is Circuit UI''s one ring: 2px off-white inside 4px near-black.'
  button-secondary:
    type: button
    backgroundColor: '#fbfbf9'
    textColor: '#1e1c1c'
    border: '#d0cdc3'
    rounded: 12px
    height: 48px
    padding: 11px 23px
    typography: 17px / 550
    hover: '#f0eee7, border #ded7cf'
    pressed: '#e8e6dc, border #cac4be'
    focus: 'ring 0 0 0 2px #fbfbf9, 0 0 0 4px #1e1c1c'
    use: Mehr erfahren — the outlined twin on --cui-bg-normal with --cui-border-normal; hover and press warm the fill and border.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#1e1c1c'
    rounded: 4px
    height: 64px
    typography: 17px / 375
    hover: 'fg #726767'
    pressed: 'fg #887a7a'
    focus: 'ring 0 0 0 2px #fbfbf9, 0 0 0 4px #1e1c1c'
    use: Top navigation (Preise). Hover and press fade the label to --cui-fg-accent-hovered and -pressed; inline product links share the recipe.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: SumUp Narrow
    display: SumUp Black
---

# SumUp

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SumUp; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/sumup/DESIGN.md
