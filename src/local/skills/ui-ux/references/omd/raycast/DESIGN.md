---
name: Raycast
colors:
  background: '#07080a'
  surface: '#101111'
  card: '#1b1c1e'
  white: '#ffffff'
  accent: '#ff6363'
  body: '#f9f9f9'
  secondary: '#cecece'
  silver: '#c0c0c0'
  link: '#9c9c9d'
  dim: '#6a6b6c'
  dark-gray: '#434345'
  border: '#2f3031'
  button-fg: '#18191a'
  key-start: '#121212'
  key-end: '#0d0d0d'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: 0px
    use: Hero display
  section:
    fontSize: 56px
    fontWeight: 400
    lineHeight: 1.17
    letterSpacing: 0.2px
    use: Section display
  heading:
    fontSize: 24px
    fontWeight: 500
    letterSpacing: 0.2px
    use: Section heading
  card-heading:
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: 0px
    use: Card heading
  body:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: 0.2px
    use: Primary body text
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: 0.3px
    use: Button label
  caption:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.14
    letterSpacing: 0.2px
    use: Small labels, metadata
  code:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: 0.3px
    use: Code blocks (GeistMono)
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 40
  section: 80
components:
  button-primary:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 9999px
    padding: 10px 16px
    typography: 16/600
    use: Primary pill button, inset white highlight
  button-cta:
    type: button
    textColor: '#18191a'
    rounded: 9999px
    padding: 10px 16px
    use: Hero Download CTA, translucent white fill
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#6a6b6c'
    rounded: 9999px
    padding: 10px 16px
    use: Tertiary action, gray text brightens on hover
  input:
    type: input
    backgroundColor: '#07080a'
    textColor: '#f9f9f9'
    rounded: 8px
    padding: 10px 12px
    use: Form input on dark, blue focus glow
  card:
    type: card
    backgroundColor: '#101111'
    textColor: '#ffffff'
    rounded: 12px
    padding: 16px
    use: Default dark card, faint white border
  card-feature:
    type: card
    backgroundColor: '#101111'
    rounded: 20px
    padding: 24px
    use: Hero/feature card with warm glow
  badge:
    type: badge
    backgroundColor: '#1b1c1e'
    textColor: '#ffffff'
    rounded: 6px
    padding: 0 6px
    typography: 14/500
    use: Categorization badge
  nav-top:
    type: tab
    backgroundColor: '#07080a'
    textColor: '#9c9c9d'
    typography: 16/500
    use: Top nav links, white on hover
    active: white text on hover, underline
fonts:
  roles:
    sans: Inter
    mono: GeistMono
---

# Raycast

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Raycast; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/raycast/DESIGN.md
