---
name: Nintendo
colors:
  primary: '#e60012'
  ink: '#484848'
  ink-jp: '#3c3c3c'
  muted: '#727272'
  muted-jp: '#8c8c8c'
  disabled: '#c8c8c8'
  on-primary: '#ffffff'
  canvas: '#ffffff'
  surface: '#f8f8f8'
  surface-alt: '#efefef'
  surface-jp: '#f2f2f2'
  hairline: '#e0e0e0'
  eshop-green: '#468254'
  accent-blue: '#4b5cce'
  accent-navy: '#27455c'
typography:
  display:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.35
    use: Section/feature headline (H2), Geologica
  subheading:
    fontSize: 21px
    fontWeight: 600
    lineHeight: 1.4
    use: Card / panel head (H2)
  label:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Section label, nav, eyebrow
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    use: Standard reading text, US
  body-jp:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 2
    use: Standard reading text, JP (32px line-height)
  button:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1
    use: Primary CTA label
  nav:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    use: Top nav menu item
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Search input, small labels
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 12px
  pill: 48px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#e60012'
    textColor: '#ffffff'
    rounded: 8px
    height: 48px
    padding: 0 24px
    typography: 18px / 600 Geologica
    use: Primary CTA — Log in, Learn more, Start shopping
  button-play:
    type: button
    backgroundColor: '#e60012'
    textColor: '#ffffff'
    rounded: 48px
    height: 32px
    padding: 0 16px
    typography: 16px / 600 Geologica
    use: Inline Play pill on media cards
  button-utility:
    type: button
    backgroundColor: '#f8f8f8'
    textColor: '#484848'
    rounded: 20px
    height: 32px
    padding: 8px 12px
    typography: 14px / 600 Geologica
    use: Header utility pills — Search, Wish List, Cart
  link-red:
    type: button
    textColor: '#e60012'
    typography: 16px / 600 Geologica
    use: Trending-topic / inline navigational link, red text on transparent
  nav-item:
    type: tab
    textColor: '#484848'
    typography: 14px / 600 Geologica
    use: Top nav menu trigger (Explore, Shop, Support)
    active: 'text #e60012'
  card-media:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    shadow: rgba(0,0,0,0.07) 0px 2px 8px
    use: Game/topic media tile
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#484848'
    rounded: 0px
    typography: 14px / 400 Geologica
    use: Header search field, bottom-border affordance
  carousel-arrow:
    type: button
    textColor: '#dadada'
    rounded: 8px
    padding: 16px
    use: Hero carousel prev/next, rgba(0,0,0,0.3) scrim bg
fonts:
  roles:
    sans: Geologica Variable
    cjk: YakuHanJPs, Roboto, Hiragino Kaku Gothic ProN
    mono: system-ui
---

# Nintendo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Nintendo; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/nintendo/DESIGN.md
