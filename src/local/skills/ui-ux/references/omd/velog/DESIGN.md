---
name: velog
colors:
  primary: '#12b886'
  primary-alt: '#20c997'
  destructive: '#ff6b6b'
  text: '#212529'
  body: '#495057'
  muted: '#868e96'
  canvas: '#f8f9fa'
  surface: '#ffffff'
  border: '#e9ecef'
  border-strong: '#dee2e6'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: Body copy, reading surface
  login:
    fontSize: 16px
    fontWeight: 700
    use: Login pill label
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
  button-login:
    type: button
    backgroundColor: '#212529'
    textColor: '#ffffff'
    rounded: 16px
    typography: 16px/700
    hover: '#343a40'
    focus: '#343a40'
    disabled: '#f8f9fa'
    use: Dark sign-in pill, top-right header, h32
  button-write:
    type: button
    backgroundColor: '#12b886'
    textColor: '#ffffff'
    hover: '#20c997'
    focus: '#20c997'
    use: Brand teal primary-action — compose a post
  header:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#212529'
    typography: 16px
    use: Top navigation surface
  page:
    type: card
    backgroundColor: '#f8f9fa'
    textColor: '#212529'
    typography: 16px
    use: Soft-gray reading canvas framing white blocks
fonts:
  roles:
    sans: system-ui
    mono: ui-monospace
---

# velog

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to velog; reproduced for educational reference. Full prose: https://oh-my-design.kr/velog/design.md
