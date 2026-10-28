---
name: Cookpad
colors:
  primary: '#FF9933'
  brand: '#FF9933'
  canvas: '#F8F6F2'
  surface: '#FFFFFF'
  cream-tint: '#FEF9EE'
  warm-gray: '#ECEBE9'
  foreground: '#0F0F0F'
  body: '#4A4A4A'
  muted: '#4A4A4A'
  on-primary: '#FFFFFF'
  accent-yellow: '#E9B83F'
  pale-yellow: '#FAF5D7'
typography:
  section:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.3
    use: Section headings
  title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Recipe card title
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Primary button label
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body / recipe meta / category label
rounded:
  sm: 8px
  md: 8px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#FF9933'
    textColor: '#FFFFFF'
    rounded: 8px
    padding: 8px 24px
    typography: 16/600
    use: Main action — search, post recipe, sign up
  button-secondary:
    type: button
    backgroundColor: '#FFFFFF'
    textColor: '#FF9933'
    rounded: 8px
    use: 'Outline, 1px #FF9933 border — lower-emphasis beside primary'
  button-text:
    type: button
    textColor: '#4A4A4A'
    use: Transparent tertiary / navigation action
  button-disabled:
    type: button
    backgroundColor: '#ECEBE9'
    textColor: '#4A4A4A'
    use: Unavailable action
  category-tile:
    type: button
    textColor: '#0F0F0F'
    rounded: 8px
    padding: 16px
    typography: 16/400
    use: Ingredient/category navigation — large tappable icon + label
  recipe-card:
    type: card
    backgroundColor: '#FFFFFF'
    textColor: '#0F0F0F'
    rounded: 8px
    use: Food photo top, title + meta below, floating on cream page
  promoted-card:
    type: card
    backgroundColor: '#FEF9EE'
    rounded: 8px
    use: Featured / promoted recipe region
  search-input:
    type: input
    backgroundColor: '#FFFFFF'
    textColor: '#0F0F0F'
    rounded: 8px
    padding: 12px 16px
    use: 'Central recipe search; focus ring in #FF9933'
  rating-badge:
    type: badge
    backgroundColor: '#FAF5D7'
    textColor: '#4A4A4A'
    rounded: 8px
    use: Ratings, つくれぽ counts, promoted labels
fonts:
  roles:
    sans: Noto Sans
---

# Cookpad

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cookpad; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/cookpad/DESIGN.md
