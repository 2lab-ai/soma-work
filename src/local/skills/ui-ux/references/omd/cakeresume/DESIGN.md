---
name: Cake
colors:
  primary: '#13AB67'
  brand: '#13AB67'
  canvas: '#FFFFFF'
  foreground: '#000000'
  heading: '#0C4129'
  accent: '#378060'
  muted: '#E2E6E4'
  hairline: '#D1D6D4'
  chip-text: '#0E0E0F'
  on-primary: '#FFFFFF'
typography:
  heading:
    fontSize: 38px
    fontWeight: 600
    use: Page headings, deep-green anchor
  body:
    fontSize: 16px
    fontWeight: 400
    use: Standard reading text
  control:
    fontSize: 14px
    fontWeight: 400
    use: Button and control labels
rounded:
  sm: 4px
  md: 4px
  lg: 4px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#13AB67'
    textColor: '#FFFFFF'
    border: none
    rounded: 4px
    height: 32px
    typography: 14px / 400
    use: Single most important action (Sign Up, primary submit)
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#13AB67'
    border: none
    rounded: 4px
    height: 32px
    typography: 14px / 400
    use: Quieter Log In beside primary
  language-selector:
    type: input
    backgroundColor: '#FFFFFF'
    textColor: '#000000'
    border: '1px solid #D1D6D4'
    rounded: 4px
    height: 32px
    typography: 14px / 400
    use: Header locale/language switcher
  chip-neutral:
    type: badge
    backgroundColor: '#E2E6E4'
    textColor: '#0E0E0F'
    border: none
    rounded: 4px
    use: Receding metadata/tag pills
fonts:
  roles:
    sans: Inter
    cjk: Apple SD Gothic Neo
---

# Cake

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cake; reproduced for educational reference. Full prose: https://oh-my-design.kr/cakeresume/design.md
