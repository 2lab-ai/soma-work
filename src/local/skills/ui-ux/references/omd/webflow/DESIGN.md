---
name: Webflow
colors:
  ink: '#080808'
  primary: '#146ef5'
  blue-400: '#3b89ff'
  blue-300: '#006acc'
  button-hover: '#0055d4'
  purple: '#7a3dff'
  pink: '#ed52cb'
  green: '#00d722'
  orange: '#ff6b00'
  yellow: '#ffae13'
  red: '#ee1d36'
  gray-800: '#222222'
  gray-700: '#363636'
  gray-500: '#5a5a5a'
  gray-300: '#ababab'
  border: '#d8d8d8'
  border-hover: '#898989'
typography:
  display-hero:
    fontSize: 80px
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: '-0.8px'
    use: Hero headline
  section:
    fontSize: 56px
    fontWeight: 600
    lineHeight: 1.04
    use: Section heading
  subheading:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.3
    use: Sub-heading
  feature-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    use: Feature title
  body:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: Body text
  body-standard:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.16px'
    use: Standard body
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: '-0.16px'
    use: Button label
  uppercase-label:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 1.5px
    use: Uppercase label
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Caption
  badge:
    fontSize: 12px
    fontWeight: 550
    lineHeight: 1.2
    use: Badge uppercase
  micro:
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 1px
    use: Micro uppercase
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
components:
  button-primary:
    type: button
    backgroundColor: '#146ef5'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 16px
    typography: 16px/550 WF Visual Sans Variable
    use: Primary CTA, Webflow Blue
  button-transparent:
    type: button
    textColor: '#080808'
    rounded: 4px
    padding: 8px 16px
    typography: 16px/550 WF Visual Sans Variable
    use: Text button, hover translate 6px
  button-circle:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#080808'
    rounded: 9999px
    padding: 12px
    use: Circular icon button
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#080808'
    rounded: 4px
    padding: 8px 12px
    typography: 16px/500 WF Visual Sans Variable
    use: 'Form input, 1px #d8d8d8, focus #146ef5'
  card-standard:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 24px
    use: 'Content card, 1px #d8d8d8 border'
  card-compact:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 16px
    use: 'Smaller utility container, 1px #d8d8d8'
  badge-blue:
    type: badge
    backgroundColor: '#146ef5'
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/550 WF Visual Sans Variable
    use: Solid blue badge
  badge-tinted:
    type: badge
    textColor: '#146ef5'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/550 WF Visual Sans Variable
    use: Subtle tinted badge, 10% blue bg
  badge-micro:
    type: badge
    textColor: '#080808'
    rounded: 4px
    padding: 2px 6px
    typography: 10px/600 WF Visual Sans Variable
    use: Uppercase micro-label, +1px tracking
fonts:
  roles:
    sans: WF Visual Sans Variable
    mono: Inconsolata
---

# Webflow

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Webflow; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/webflow/DESIGN.md
