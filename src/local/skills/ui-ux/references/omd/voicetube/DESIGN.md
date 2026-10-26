---
name: VoiceTube
colors:
  primary: '#7e3aaf'
  vibrant: '#a73aaf'
  gradient-start: '#653aaf'
  deep-purple: '#210040'
  canvas: '#18131d'
  surface: '#251633'
  nav-end: '#1d102b'
  tint: '#e0d0ec'
  body: '#e3e3e3'
  secondary: '#b4b4b4'
  placeholder: '#9ca3af'
  error: '#ed4f55'
  success: '#33991d'
  link: '#4283e4'
  on-primary: '#ffffff'
typography:
  h2xl:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.425
    use: Largest headings
  xl:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.425
    use: Section heads
  lg:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.425
    use: Sub-heads
  base:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.425
    use: Body, button labels
  sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.425
    use: Secondary text, tags
  xs:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.425
    use: Captions, fine print
rounded:
  sm: 4px
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
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#653aaf'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 0 20px
    typography: 16px/500
    use: 'Gradient CTA #653AAF→#A73AAF, h40'
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#e3e3e3'
    rounded: 9999px
    padding: 0 20px
    typography: 16px/500
    use: 'Ghost/secondary; 1px #e3e3e3 border, h40'
  nav:
    type: tab
    backgroundColor: '#210040'
    textColor: '#e3e3e3'
    use: 'Top nav gradient #210040→#1D102B, h64'
  sidebar-item:
    type: listItem
    backgroundColor: '#251633'
    textColor: '#e3e3e3'
    rounded: 0px
    padding: 12px 8px
    typography: 14px/400
    use: Sidebar nav item; active rgba purple tint
  tag:
    type: badge
    backgroundColor: '#7e3aaf'
    textColor: '#e3e3e3'
    rounded: 4px
    padding: 2.5px 12px
    typography: 14px/400
    use: Brand tag chip
  input:
    type: input
    backgroundColor: transparent
    textColor: '#e3e3e3'
    rounded: 4px
    use: 'Text input; 1px #e3e3e3 border, focus #7e3aaf, error #ed4f55'
fonts:
  roles:
    sans: PingFang TC
    mono: ui-monospace
---

# VoiceTube

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to VoiceTube; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/voicetube/DESIGN.md
