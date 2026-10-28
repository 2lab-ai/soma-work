---
name: GMO Pepabo (Inhouse)
colors:
  primary: '#1f7ccc'
  primary-strong: '#0a62ad'
  primary-bright: '#3e93de'
  link: '#005bac'
  ink: '#393c41'
  ink-strong: '#1f2124'
  body: '#585c63'
  muted: '#767b85'
  faint: '#9297a1'
  hairline: '#dee0e3'
  surface: '#edeef0'
  surface-soft: '#f7f8fa'
  canvas: '#ffffff'
  on-primary: '#ffffff'
  brand-mint: '#30f4c5'
  brand-mint-deep: '#0e7365'
  positive: '#1dc487'
  notice: '#debf43'
  negative: '#cc1f24'
  negative-strong: '#b50b11'
  attention: '#db7d42'
  ink-black: '#000000'
typography:
  xxxl:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    use: Largest display heading (XXXL)
  xxl:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    use: Page / section heading (XXL)
  xl:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Subsection heading (XL)
  l:
    fontSize: 21px
    fontWeight: 700
    lineHeight: 1.14
    use: Card / brand title (L)
  m:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body baseline (M), normal density 24px
  s:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Dense UI text / small button (S)
  xs:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Caption, small button label (XS)
  xxs:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.45
    use: Fine print, smallest label (XXS)
rounded:
  sm: 4px
  pill: 20px
  full: 9999px
spacing:
  xxs: 4
  xs: 8
  sm: 12
  base: 16
  md: 24
  lg: 32
  xl: 48
  xxl: 64
components:
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    height: 40px
    typography: 16px / 400 Open Sans
    shadow: level1
    use: Neutral pepper primary action (保存); brand flavor overwrites bg
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#585c63'
    border: '1px solid #585c63'
    rounded: 4px
    height: 40px
    typography: 16px / 400 Open Sans
    use: Secondary/outlined action on neutral flavor
  button-pill:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 20px
    height: 32px
    typography: 16px / 400 Open Sans
    use: Rounded pill button variant (icon / compact)
  button-small:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    height: 24px
    typography: 12px / 400 Open Sans
    use: Small (XS) button size
  textfield:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#393c41'
    rounded: 4px
    padding: 8px 16px
    height: 40px
    typography: 16px / 400 Open Sans
    use: 'Default Textfield; border drawn via inset, focus blue #1f7ccc'
  textfield-filled:
    type: input
    backgroundColor: '#edeef0'
    textColor: '#393c41'
    rounded: 4px 4px 0px 0px
    padding: 8px 16px
    height: 40px
    typography: 16px / 400 Open Sans
    use: Filled / underline Textfield variant
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    shadow: level1
    use: 'Elevated content card, 1px #dee0e3 hairline option'
  nav-link:
    type: tab
    textColor: '#585c63'
    typography: 16px / 400 Open Sans
    rounded: 4px
    active: 'text #393c41 weight 700'
    use: Top App Bar / sidebar nav item
  badge-positive:
    type: badge
    backgroundColor: '#30f4c5'
    textColor: '#0e7365'
    rounded: 4px
    typography: 14px / 400 Open Sans
    use: Brand mint status pill (e.g. 無料診断中)
  badge-negative:
    type: badge
    backgroundColor: '#cc1f24'
    textColor: '#ffffff'
    rounded: 4px
    typography: 12px / 400 Open Sans
    use: Negative / error intention badge
  avatar:
    type: avatar
    rounded: 9999px
    use: Circular user avatar (Avatar component)
fonts:
  roles:
    sans: Open Sans
    cjk: Noto Sans JP
    kerning: YakuHanJP
    mono: Roboto Mono
---

# GMO Pepabo (Inhouse)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to GMO Pepabo (Inhouse); reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/pepabo/DESIGN.md
