---
name: 誠品
colors:
  accent: '#917e57'
  canvas: '#ffffff'
  foreground: '#212529'
  muted: '#999999'
  hairline: '#cccccc'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    use: Repeated public commerce text and product-card samples; the computed Noto Sans TC stack is unresolved and is not a named Eslite UI-family token.
  compact-control:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    use: Observed compact public header control only; no complete control type scale is claimed.
rounded:
  square: 0px
  search-left: 8px
spacing:
  search-y: 6
  search-x: 12
  search-leading: 16
components:
  public-search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#999999'
    border: '1px 0px 1px 1px #cccccc'
    rounded: 8px 0px 0px 8px
    padding: 6px 12px 6px 16px
    height: 40px
    typography: 16px / 400 / 24px / unresolved computed stack
    states: default geometry observed on home, brand directory, and expo brand pages; static focus and pressed samples are present, while interactionCount is 0
    use: Public search text input; selector home::[data-omd-capture=11].
    pressed: '#212224'
    focus: '#212224'
  expo-product-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#212529'
    border: 0px rgba(0, 0, 0, 0.176)
    rounded: 0px
    padding: 0px
    height: 270px
    typography: 16px / 400 / 24px / unresolved computed stack
    use: Public expo-brand product-card shell; selector surface-3::[data-omd-capture=91].
---

# 誠品

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 誠品; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/eslite/DESIGN.md
