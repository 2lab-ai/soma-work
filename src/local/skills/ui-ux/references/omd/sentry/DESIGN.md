---
name: Sentry
colors:
  primary: '#79628c'
  primary-hover: '#6a5fc1'
  brand: '#362d59'
  canvas: '#1f1633'
  canvas-deep: '#150f23'
  foreground: '#ffffff'
  muted: '#e5e7eb'
  on-primary: '#ffffff'
  accent-lime: '#c2ef4e'
  accent-coral: '#ffb287'
  accent-pink: '#fa7faa'
  accent-violet: '#422082'
  hairline: '#cfcfdb'
  border-dark: '#362d59'
  code-yellow: '#dcdcaa'
typography:
  display-hero:
    fontSize: 88px
    fontWeight: 700
    lineHeight: 1.2
    use: Hero headlines (Dammit Sans), brand voice
  display-secondary:
    fontSize: 60px
    fontWeight: 500
    lineHeight: 1.1
    use: Secondary hero text (Dammit Sans)
  section:
    fontSize: 30px
    fontWeight: 400
    lineHeight: 1.2
    use: Major section titles
  subheading:
    fontSize: 27px
    fontWeight: 500
    lineHeight: 1.25
    use: Feature section headers
  card-title:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.25
    use: Card and block headings
  feature-title:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    use: Emphasized feature names
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body text
  nav-label:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.4
    use: Navigation links
  button:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.2px
    use: Uppercase button label
  caption:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 2
    use: Subtle annotations
  code:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Code blocks (Monaco)
rounded:
  sm: 6px
  md: 8px
  lg: 13px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 40
components:
  button-primary:
    type: button
    backgroundColor: '#79628c'
    textColor: '#ffffff'
    border: '1px solid #362d59'
    rounded: 13px
    typography: 14px / 700
    shadow: rgba(0,0,0,0.1) 0px 1px 3px 0px inset
    hover: rgba(0,0,0,0.18) 0px 0.5rem 1.5rem
    use: Primary muted-purple action, uppercase
  button-glass:
    type: button
    backgroundColor: rgba(255,255,255,0.18)
    textColor: '#ffffff'
    rounded: 12px
    padding: 8px
    shadow: rgba(0,0,0,0.08) 0px 2px 8px
    hover: rgba(54,22,107,0.14)
    use: Secondary action on dark surfaces
  button-white:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1f1633'
    rounded: 8px
    padding: 12px 16px
    hover: 'bg #6a5fc1, text #ffffff'
    focus: 'bg #ffb287, outline #6a5fc1'
    use: High-visibility CTA on dark
  button-violet:
    type: button
    backgroundColor: '#422082'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 16px
    use: Select / dropdown
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1f1633'
    border: '1px solid #cfcfdb'
    rounded: 6px
    padding: 8px 12px
    focus: rgba(0,0,0,0.15) 0px 2px 10px inset
    use: Text input
  card:
    type: card
    rounded: 12px
    shadow: rgba(0,0,0,0.1) 0px 10px 15px -3px
    use: Glass / dark purple surface, backdrop blur(18px)
fonts:
  roles:
    sans: Rubik
    mono: Monaco
---

# Sentry

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Sentry; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/sentry/DESIGN.md
