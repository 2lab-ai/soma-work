---
name: Farfetch
colors:
  primary: '#222222'
  canvas: '#ffffff'
  graphite: '#727272'
  muted: '#b6b6b6'
  hairline: '#e6e6e6'
  surface: '#f5f5f5'
  on-primary: '#ffffff'
  error: '#cc0000'
typography:
  display-hero:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.3px'
    use: Section hero headlines, h3 newsletter
  section:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.31
    use: H2 section headings (Womenswear, Menswear)
  nav-primary:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.33
    use: Main nav links, body copy
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.33
    use: Product tile labels, metadata
  button:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.33
    use: Primary CTA button label
rounded:
  sm: 0px
  md: 0px
  lg: 0px
  full: 0px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 24
  lg: 48
  xl: 72
  section: 96
components:
  button-primary:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    rounded: 0px
    padding: 10px 16px
    typography: 15px / 700
    use: Primary CTA (Sign Up, Add to Bag, Checkout)
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #222222'
    rounded: 0px
    padding: 10px 16px
    typography: 15px / 700
    use: Secondary actions, ghost variant
  input-email:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: 0px
    rounded: 0px
    padding: 0px 0px 0px 16px
    typography: 15px / 400
    use: Newsletter email input — no border, underline-only on search
  product-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 0px
    use: Product tile — full-bleed image, 0 radius, 0 shadow, caption below at 13px
  nav-tab:
    type: tab
    textColor: '#222222'
    typography: 15px / 400
    active: 'text #222222'
    use: 'Top nav: Womenswear / Menswear / Kidswear'
  badge-sale:
    type: badge
    backgroundColor: '#222222'
    textColor: '#ffffff'
    rounded: 0px
    typography: 13px / 700
    use: Sale label, promotion badge on product tile
  footer-link:
    type: listItem
    textColor: '#ffffff'
    typography: 15px / 400
    use: 'Footer nav links on #222222 dark background'
fonts:
  roles:
    sans: '"Farfetch Basis"'
    fallback: '"Helvetica Neue", Arial, sans-serif'
---

# Farfetch

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Farfetch; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/farfetch/DESIGN.md
