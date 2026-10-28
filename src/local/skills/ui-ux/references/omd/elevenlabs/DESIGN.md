---
name: ElevenLabs
colors:
  canvas: '#ffffff'
  surface: '#f5f3f1'
  foreground: '#000000'
  muted: '#777169'
  hairline: '#e5e5e5'
  primary: '#000000'
  on-primary: '#ffffff'
typography:
  display:
    fontSize: 48px
    fontWeight: 300
    lineHeight: 1.08
    use: Waldenburg h1 on captured public marketing home
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.6
    use: Inter repeated body/list text on captured public routes
  control:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1
    use: Inter public primary-action sample
rounded:
  sm: 4px
  md: 12px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 12
  xl: 16
  xxl: 20
components:
  public-selected-tab:
    type: tab
    rounded: 14px
    padding: 0px 21px 0px 20px
    typography: 18px/400 Inter
    states: selected via aria-selected=true; no measured visual delta
    use: One public-home selected tab; not a product-wide component contract
fonts:
  roles:
    ui: Inter
    display: Waldenburg
---

# ElevenLabs

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ElevenLabs; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/elevenlabs/DESIGN.md
