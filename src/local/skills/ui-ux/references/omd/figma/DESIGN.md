---
name: Figma
colors:
  primary: '#000000'
  canvas: '#ffffff'
  border: '#ebebeb'
  indigo-action: '#4d49fc'
  focus: '#0d99ff'
  on-primary: '#ffffff'
typography:
  hero:
    fontSize: 86px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-1.72px'
    use: Public product-marketing hero
  section:
    fontSize: 64px
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: '-0.96px'
    use: Public feature section heading
  body:
    fontSize: 16px
    fontWeight: 330
    lineHeight: 1.42
    letterSpacing: '-0.14px'
    use: Public body, navigation, and action copy
  mono-label:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: 0.54px
    use: Uppercase technical signpost
rounded:
  control: 8px
  hero: 16px
  segment: 50px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 24
  xl: 32
components:
  primary-action:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 21px
    height: 49px
    typography: 16px / 330
    focus: '2px dashed #0d99ff'
    use: Default public get-started action
    hover: oklab(0 0 0)
    pressed: oklab(0 0 0)
  indigo-action:
    type: button
    backgroundColor: '#4d49fc'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 20px
    height: 49px
    typography: 18px / 480
    states: default captured; no hover token promoted
    use: Alternate prominent public hero action
  outline-action:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 8px
    padding: 12px 21px
    height: 49px
    typography: 16px / 400
    states: default captured; no hover token promoted
    use: Current sales-contact and secondary action
  product-segment:
    type: tab
    backgroundColor: rgba(0,0,0,0.08)
    textColor: '#000000'
    rounded: 50px
    padding: 8px 18px 10px
    height: 43px
    typography: 18px / 480
    states: active and inactive variants captured
    use: Product-area segmented navigation
  round-icon:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 9999px
    size: 40px
    states: default captured; light and dark surface variants remain local
    use: Circular carousel/navigation action on public design pages
fonts:
  roles:
    ui: figmaSans
    mono: figmaMono
---

# Figma

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Figma; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/figma/DESIGN.md
