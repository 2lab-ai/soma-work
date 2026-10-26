---
name: PayPal
colors:
  primary: '#002991'
  primary-light: '#60cdff'
  canvas: '#ffffff'
  on-primary: '#ffffff'
  ink: '#000000'
  link: '#0070e0'
  muted: '#686a6d'
  surface-warm: '#f1efea'
  surface-grey: '#edf0f2'
  surface-light-blue: '#f0f2f9'
  accent-sky: '#60cdff'
  accent-pale-sky: '#b8e9ff'
  border-default: '#e6e7e8'
  success: '#007a56'
  error: '#c0212b'
typography:
  display-hero:
    fontSize: 99px
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: '-1.5px'
    use: Homepage hero headline — PayPal Pro ExtraBold
  display-lg:
    fontSize: 67px
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: '-1px'
    use: Section headings — PayPal Pro ExtraBold
  section:
    fontSize: 45px
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: '-0.6px'
    use: Sub-section titles — PayPal Pro
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    use: Standard UI and body text — Plain
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Navigation links — Plain
  button:
    fontSize: 18px
    fontWeight: 900
    lineHeight: 1
    use: CTA button labels — PayPal Pro
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Small labels and metadata — Plain
rounded:
  sm: 4px
  md: 8px
  lg: 25px
  full: 1000px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 24
  lg: 32
  xl: 48
  xxl: 64
  section: 96
components:
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 1000px
    padding: 14px 33px
    height: 52px
    typography: 18px / 900 PayPal Pro
    use: Primary CTA — black fill on light backgrounds
  button-outline-dark:
    type: button
    textColor: '#000000'
    border: '1px solid #000000'
    rounded: 1000px
    padding: 14px 33px
    height: 52px
    typography: 18px / 900 PayPal Pro
    use: Secondary CTA on light sections
  button-outline-light:
    type: button
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 1000px
    padding: 14px 33px
    height: 52px
    typography: 18px / 900 PayPal Pro
    use: Secondary CTA on dark blue sections
  button-white:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #ffffff'
    rounded: 1000px
    padding: 14px 33px
    height: 52px
    typography: 18px / 900 PayPal Pro
    use: Play/video CTA on dark surfaces
  nav-tab:
    type: tab
    textColor: '#000000'
    typography: 16px / 400 Plain
    rounded: 104px
    padding: 0 20px
    height: 40px
    active: black bg with link-blue text
    use: Top nav section tabs (Personal / Business)
  input-form:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #e6e7e8'
    rounded: 8px
    typography: 16px / 400 Plain
    use: 'Login and form inputs, focus ring #0070e0'
  card-surface:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    shadow: rgba(0,0,0,0.08) 0px 24px 48px 0px
    use: Elevated content card — layered-card class; large-radius diffuse lift shadow
  badge-status:
    type: badge
    backgroundColor: '#f0f2f9'
    textColor: '#002991'
    rounded: 4px
    padding: 2px 8px
    typography: 12px / 400 Plain
    use: Status and category tag
  cookie-dialog:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 1000px
    border: '2px solid #cfd3d8'
    use: Cookie consent bottom bar action buttons
fonts:
  roles:
    display: PayPal Pro
    ui: Plain
    fallback: Helvetica Neue, Arial, sans-serif
---

# PayPal

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PayPal; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/paypal/DESIGN.md
