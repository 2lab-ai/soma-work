---
name: Richart
colors:
  primary: '#17b6c9'
  primary-hover: '#15a6b7'
  primary-soft: '#64cedb'
  accent-cyan: '#2be0ec'
  accent-bright: '#30dde8'
  accent-lime: '#dafa5f'
  canvas: '#fdfdfd'
  surface: '#f3f5f6'
  surface-alt: '#edf0f2'
  heading: '#2a3342'
  ink: '#1b2028'
  label: '#364053'
  body: '#727d8c'
  muted: '#b6bec7'
  on-primary: '#fdfdfd'
  hairline: '#dce0e5'
  border-soft: '#c7cdd4'
  teal-deep: '#001617'
  warn: '#cb904c'
  error: '#e75365'
typography:
  display-hero:
    fontSize: 60px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-2px'
    use: Hero headlines, big friendly statements
  display-lg:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: 0px
    use: Section hero headlines
  section:
    fontSize: 34px
    fontWeight: 700
    lineHeight: 1.3
    use: Feature section titles
  subsection:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.4
    use: Sub-section heads, card titles
  title:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.55
    use: Block titles with teal accent bar
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.67
    use: Lead paragraphs, intro copy
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  button:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.6
    use: Primary pill button label
  label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Nav links, small labels
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Fine print, legal, metadata
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  pill: 32px
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
    backgroundColor: '#17b6c9'
    textColor: '#fdfdfd'
    rounded: 9999px
    typography: 20/500
    use: 'Primary CTA pill, hover #15a6b7'
  button-primary-xl:
    type: button
    textColor: '#fdfdfd'
    rounded: 9999px
    padding: 16px 0
    use: 'Hero action, radial gradient #64cedb to #15a6b7, 240px wide'
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#17b6c9'
    rounded: 9999px
    use: 'Secondary action, 2px #17b6c9 border, hover fills teal'
  card:
    type: card
    backgroundColor: '#fdfdfd'
    rounded: 16px
    use: Feature card, neumorphic inset shadow
  badge-teal:
    type: badge
    backgroundColor: '#ecf9fa'
    textColor: '#17b6c9'
    rounded: 9999px
    use: Teal-themed tag
  badge-neutral:
    type: badge
    backgroundColor: '#f3f5f6'
    textColor: '#727d8c'
    rounded: 16px
    use: Neutral tag
  input:
    type: input
    backgroundColor: '#fdfdfd'
    textColor: '#1b2028'
    rounded: 8px
    use: 'Form input, 1px #c7cdd4 border, #17b6c9 focus, #e75365 error'
  title-bar:
    type: badge
    backgroundColor: '#17b6c9'
    use: 4px x 24px vertical accent bar before block title
  badge-disabled:
    type: badge
    backgroundColor: '#727d8c'
    textColor: rgba(253,253,253,0.5)
    rounded: 9999px
    use: Disabled button state
fonts:
  roles:
    sans: Noto Sans TC
    display: Montserrat
---

# Richart

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Richart; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/richart/DESIGN.md
