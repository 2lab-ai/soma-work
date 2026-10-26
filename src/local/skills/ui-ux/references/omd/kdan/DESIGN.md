---
name: Kdan Mobile
colors:
  primary: '#002d37'
  brand: '#00dc87'
  accent-lime: '#caff00'
  canvas: '#ffffff'
  foreground: '#191919'
  muted: '#4b4b4b'
  on-primary: '#ffffff'
  surface: '#fafafa'
  body: '#191919'
  link: '#007aff'
  error: '#f25858'
  disabled: '#afafaf'
typography:
  hero:
    fontSize: 56px
    fontWeight: 700
    use: Hero heading, steep declarative top
  hero-cta:
    fontSize: 22px
    fontWeight: 500
    use: Hero CTA label
  body:
    fontSize: 16px
    fontWeight: 400
    use: Standard body, document-heavy reading
  button:
    fontSize: 16px
    fontWeight: 500
    use: Standard button label, medium weight
rounded:
  sm: 4px
  md: 4px
  lg: 4px
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
    backgroundColor: '#002d37'
    textColor: '#ffffff'
    border: '1.5px solid #002d37'
    rounded: 4px
    height: 38px
    typography: 16px / 500
    hover: rgba(0,0,0,0.2) overlay
    use: Primary action on live kdan.com
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#002d37'
    border: '1.5px solid #002d37'
    rounded: 4px
    height: 38px
    typography: 16px / 500
    use: Secondary action paired with solid primary
  button-hero:
    type: button
    backgroundColor: '#caff00'
    textColor: '#000000'
    rounded: 4px
    height: 53px
    typography: 22px / 500
    use: Single loud high-emphasis hero CTA
  button-disabled:
    type: button
    backgroundColor: '#afafaf'
    textColor: '#4b4b4b'
    rounded: 4px
    disabled: non-interactive
    use: Disabled state
fonts:
  roles:
    sans: Clear Sans
    mono: SF Mono
---

# Kdan Mobile

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kdan Mobile; reproduced for educational reference. Full prose: https://oh-my-design.kr/kdan/design.md
