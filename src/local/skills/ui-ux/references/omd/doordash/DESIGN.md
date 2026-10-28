---
name: DoorDash
colors:
  primary: '#eb1700'
  on-primary: '#ffffff'
  canvas: '#ffffff'
  ink: '#191919'
  ink-pure: '#000000'
  muted: '#767676'
  surface: '#f6f6f6'
  hairline: '#cccccc'
  error: '#eb1700'
typography:
  display-hero:
    fontSize: 40px
    fontWeight: 900
    lineHeight: 1
    letterSpacing: '-0.5px'
    use: Hero banner headline, TTNormsProCond-Blk Black
  section:
    fontSize: 40px
    fontWeight: 800
    lineHeight: 1
    use: Section headlines ('Everything you crave, delivered.')
  subsection:
    fontSize: 32px
    fontWeight: 800
    lineHeight: 1.2
    use: Sub-section titles ('Become a Dasher')
  body-lg:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.4
    use: Feature sub-headlines, DD Norms Medium
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.15
    use: Standard body, nav links, button labels
  nav:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.15
    use: Nav links, about site
  input:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.15
    use: Address/search input text
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#eb1700'
    textColor: '#ffffff'
    rounded: 9999px
    height: 40px
    typography: 16px / 400 DD Norms
    states: hover darker red
    use: Primary CTA — 'Find restaurants', 'Get DashPass', 'Sign In'
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#191919'
    rounded: 9999px
    height: 40px
    typography: 16px / 400 DD Norms
    shadow: rgba(25,25,25,0) 0px 0px 0px 1px inset
    use: Secondary CTA — 'Sign Up'
  button-ghost-sm:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#191919'
    rounded: 9999px
    height: 32px
    typography: 16px / 400 DD Norms
    shadow: rgba(25,25,25,0) 0px 0px 0px 1px inset, rgba(25,25,25,0.2) 0px 2px 8px 0px
    use: Soft ghost — 'Sign in for saved address', 'Use current location'
  input-address:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#191919'
    rounded: 0px
    typography: 16px / 500 DD Norms
    use: Address / delivery location search field
  card-content:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#191919'
    rounded: 8px
    use: Content card, feature section
  badge-red:
    type: badge
    backgroundColor: '#eb1700'
    textColor: '#ffffff'
    rounded: 9999px
    typography: 12px / 400 DD Norms
    use: Promotional pill badge
  nav-link:
    type: tab
    textColor: '#191919'
    typography: 18px / 500 TT-Norms
    use: About-site top nav item
    active: '#191919 underline accent'
  dot-indicator:
    type: toggle
    backgroundColor: '#cccccc'
    rounded: 50%
    height: 32px
    use: Carousel prev/next slide control dot
fonts:
  roles:
    display: TTNormsProCond-Blk
    body: DD Norms
---

# DoorDash

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to DoorDash; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/doordash/DESIGN.md
