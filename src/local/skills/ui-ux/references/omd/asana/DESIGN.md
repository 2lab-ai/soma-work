---
name: Asana
colors:
  primary: '#f06a6a'
  brand-pink: '#fd3ffd'
  brand-dark: '#0d0e10'
  ink: '#0d0d0d'
  heading: '#0d0e10'
  body: '#646f79'
  muted: '#9ca6af'
  canvas: '#ffffff'
  surface: '#f3f3f3'
  surface-alt: '#fafafa'
  on-primary: '#ffffff'
  on-dark: '#ffffff'
  hairline: '#e7e7e7'
  violet: '#222875'
  sky: '#cbefff'
  coral-blush: '#ffeaec'
  deep-coral: '#690031'
  border-muted: '#6e6e6e'
typography:
  display-hero:
    fontSize: 102px
    fontWeight: 300
    lineHeight: 1
    letterSpacing: '-0.007px'
    use: Hero headline — light authority, Ghost or TWK Lausanne
  display-lg:
    fontSize: 72px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: '-0.007px'
    use: Display headings, Ghost display font
  section:
    fontSize: 54px
    fontWeight: 300
    lineHeight: 1.15
    use: Section headings
  subheading:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: '-0.01px'
    use: Card / sub-section heads
  heading-sm:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.2
    use: Small headings
  body-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    use: Lead body / subheadings
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body text
  caption:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: 0.04px
    use: Labels, captions
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  card: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 48
  xxl: 80
  section: 120
components:
  button-primary:
    type: button
    backgroundColor: '#0d0d0d'
    textColor: '#ffffff'
    rounded: 100px
    padding: 16px 32px
    height: 64px
    typography: 20px / 400 TWK Lausanne
    use: Hero primary CTA — Get started, black pill
    hover: '#6e6e6e'
  button-secondary:
    type: button
    backgroundColor: '#fafafa'
    textColor: '#0d0d0d'
    border: '1px solid #6e6e6e'
    rounded: 100px
    padding: 16px 32px
    typography: 20px / 400 TWK Lausanne
    use: Secondary outline pill — View demo, Learn more
    hover: '#f3f3f3'
  button-nav:
    type: button
    backgroundColor: '#0d0d0d'
    textColor: '#ffffff'
    rounded: 100px
    padding: 0px 16px
    height: 44px
    typography: 14px / 500 TWK Lausanne
    use: Nav bar CTA — Get started (compact)
    hover: '#6e6e6e'
  button-card:
    type: button
    backgroundColor: '#f3f3f3'
    textColor: '#0d0d0d'
    rounded: 100px
    padding: 16px 32px
    height: 50px
    typography: 16px / 500 TWK Lausanne
    use: Pricing card secondary — Get started (light)
    hover: '#e7e7e7'
  button-card-primary:
    type: button
    backgroundColor: '#0d0d0d'
    textColor: '#ffffff'
    rounded: 100px
    padding: 16px 32px
    height: 50px
    typography: 16px / 500 TWK Lausanne
    use: Pricing card primary — Get started (dark)
    hover: '#6e6e6e'
  input-default:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #e1e1e1'
    rounded: 6px
    padding: 6px 12px
    height: 36px
    typography: 14px / 400
    textColor: '#000000'
    hover: '#c6c6c6'
    focus: '#4075cf'
    use: 'Login field on app.asana.com/-/login — 36px, hairline border that darkens on hover and gains a 2px #4075cf ring on focus.'
  card-surface:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    border: '1px solid #e7e7e7'
    use: Feature / pricing card — no shadow, hairline border
  card-tinted:
    type: card
    backgroundColor: '#f3f3f3'
    rounded: 8px
    use: Tinted content card on grey surface
  badge-coral:
    type: badge
    backgroundColor: '#ffeaec'
    textColor: '#690031'
    rounded: 9999px
    typography: 12px / 400 TWK Lausanne
    use: Coral blush tag / label pill
  badge-sky:
    type: badge
    backgroundColor: '#cbefff'
    textColor: '#0d0e10'
    rounded: 9999px
    typography: 12px / 400 TWK Lausanne
    use: Sky blue tag / status pill
  toggle-on:
    type: toggle
    backgroundColor: '#24a651'
    textColor: '#ffffff'
    rounded: 100px
    hover: '#1d8541'
    focus: '#24a651'
    use: Pricing billing-period switch — on state; 22px track
fonts:
  roles:
    display: Ghost
    sans: TWK Lausanne
    fallback: Helvetica Neue, Helvetica, sans-serif
---

# Asana

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Asana; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/asana/DESIGN.md
