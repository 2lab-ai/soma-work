---
name: Bloom & Wild
colors:
  foreground: '#262626'
  foreground-muted: '#534e46'
  canvas: '#ffffff'
  linen: '#f9ecd7'
  lemon: '#fdf888'
  pine-green: '#447964'
  pine-green-light: '#a1bcb1'
  error: '#db4141'
  border: '#e2e0dc'
  search-hover: '#fcf5ea'
  focus-ring: '#2771fc'
typography:
  body:
    fontSize: 16px
    use: body computed font-family Unica 77 LL TT, weight 400
  button:
    fontSize: 18px
    use: Unica 77 LL TT 400 on the primary call to action
  nav-link:
    fontSize: 16px
    use: Unica 77 LL TT 500, mega-nav top-level items
  h1:
    fontSize: 32px
    use: Tiempos Headline 700 (Bold only face observed)
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  xxxs: 4
  xxs: 8
  xs: 12
  sm: 16
  md: 24
  lg: 32
  xl: 48
  xxl: 64
  xxxl: 80
components:
  button-primary:
    type: button
    backgroundColor: '#262626'
    textColor: '#ffffff'
    border: '#262626'
    rounded: 2px
    height: 48px
    padding: 13px 19px
    typography: 18px / 400
    hover: '#262626'
    pressed: '#262626'
    focus: 'outline 2px solid #2771fc'
    use: Claim offer — the primary promo-banner CTA. No visible change on hover or press; the 2px focus outline is the only state change.
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#262626'
    border: '#262626'
    rounded: 2px
    height: 48px
    padding: 13px 19px
    typography: 18px / 400
    hover: transparent
    pressed: transparent
    focus: 'outline 2px solid #2771fc'
    use: Next slide — the outline carousel-arrow control. No visible change on hover or press.
  nav-link:
    type: button
    backgroundColor: transparent
    textColor: '#262626'
    rounded: 0px
    height: 45px
    padding: 10px 4px 11px
    typography: 16px / 500
    hover: transparent
    pressed: transparent
    focus: 'outline 2px solid #2771fc'
    use: Flowers — a mega-nav top-level item. No visible change on hover or press.
  search-trigger:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#534e46'
    border: '#e2e0dc'
    rounded: 9999px
    height: 37px
    padding: 8px 72px 8px 36px
    typography: 16px / 400
    hover: '#fcf5ea'
    pressed: '#fcf5ea'
    focus: '#fcf5ea, outline 2px solid #2771fc'
    use: 'Search for products — the header search pill. The only control with a real colour-changing hover: a cream fill close to the linen family.'
  icon-link:
    type: button
    backgroundColor: transparent
    textColor: '#262626'
    border: '#262626'
    rounded: 0px
    height: 58px
    padding: 8px
    typography: 16px / 400
    hover: 'underline #262626'
    pressed: 'underline #262626'
    focus: 'outline 2px solid #2771fc'
    use: 'Log in — secondary-nav icon link. Hover and press underline the label in #262626.'
  card-link:
    type: card
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    height: 24px
    padding: '0'
    typography: 16px / 500
    focus: 'outline 2px solid #2771fc'
    use: 'Birthday Gifts — an image-backed category card, white label over a photo. Focus draws the #2771fc outline. Hover and press were not measured (the pointer could not reach it).'
fonts:
  roles:
    display: Tiempos Headline
    sans: Unica 77 LL TT
---

# Bloom & Wild

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bloom & Wild; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/bloomandwild/DESIGN.md
