---
name: Zoom
colors:
  primary: '#0b5cff'
  primary-hover: '#0d6bde'
  brand-dark: '#00053d'
  canvas: '#ffffff'
  surface-blue: '#f3f8ff'
  surface-tint: '#e6f0ff'
  border-light: '#d1dee2'
  heading: '#000000'
  body: '#222325'
  body-alt: '#232333'
  muted: '#696b6e'
  on-primary: '#ffffff'
  hairline: '#dfe3e8'
typography:
  display-hero:
    fontSize: 54px
    fontWeight: 500
    lineHeight: 1.12
    use: Hero headline — Happy Face Semi Bold
  display-h2:
    fontSize: 46px
    fontWeight: 400
    lineHeight: 1.14
    letterSpacing: '-1.4px'
    use: Section headings — Happy Face Semi Bold, weight 400 or 500
  display-h3:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.2
    use: Feature card headings — Happy Face Semi Bold
  ui-h2:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.2
    use: Subheadings in UI — Almaden Sans
  ui-h3:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.4px'
    use: News card titles — Almaden Sans
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body copy — Almaden Sans
  nav:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    use: Nav links, buttons — Almaden Sans
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Labels, captions — Almaden Sans
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
  lg: 20
  xl: 24
  xxl: 32
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#0b5cff'
    textColor: '#ffffff'
    rounded: 12px
    padding: 13px 14px
    height: 48px
    typography: 16px / 500 Almaden Sans
    border: '1px solid #0b5cff'
    use: Primary CTA — Buy Now, Sign Up Free
  button-secondary:
    type: button
    backgroundColor: '#f3f8ff'
    textColor: '#333333'
    rounded: 12px
    padding: 13px 14px
    height: 48px
    typography: 16px / 500 Almaden Sans
    border: '1px solid #d1dee2'
    use: Secondary CTA — Sign Up Free (outline variant), Contact Sales
  button-ghost-nav:
    type: button
    backgroundColor: '#0b5cff'
    textColor: '#ffffff'
    rounded: 12px
    padding: 4px 20px
    height: 46px
    typography: 14px / 600 Almaden Sans
    use: Nav-bar primary CTA — Sign Up Free on homepage header
  button-contact:
    type: button
    backgroundColor: '#e6f0ff'
    textColor: '#00053d'
    rounded: 12px
    padding: 4px 20px
    height: 46px
    typography: 14px / 600 Almaden Sans
    border: '1px solid #e6f0ff'
    use: Nav-bar secondary — Contact Sales
  nav-link:
    type: tab
    textColor: '#ffffff'
    typography: 14px / 500 Almaden Sans
    rounded: 12px
    use: Top nav on dark hero
    active: active = white text with subtle bg
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 8px
    use: 'Feature / product card, 1px #dfe3e8 border'
  card-tinted:
    type: card
    backgroundColor: '#f3f8ff'
    textColor: '#00053d'
    rounded: 8px
    use: Tinted info card / pricing tier card
  badge-pill:
    type: badge
    backgroundColor: '#e6f0ff'
    textColor: '#0b5cff'
    rounded: 9999px
    typography: 12px / 500 Almaden Sans
    use: Product label pill, category tag
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222325'
    border: '1px solid #dfe3e8'
    rounded: 8px
    typography: 14px / 400 Almaden Sans
    use: Search / form input
  toggle-on:
    type: toggle
    backgroundColor: '#0b5cff'
    textColor: '#ffffff'
    rounded: 9999px
    use: Feature comparison toggle, on state
fonts:
  roles:
    display: Happy Face Semi Bold
    ui: Almaden Sans
    fallback: Helvetica, Arial, sans-serif
---

# Zoom

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Zoom; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/zoom/DESIGN.md
