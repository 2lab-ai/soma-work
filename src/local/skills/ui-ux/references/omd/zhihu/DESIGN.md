---
name: Zhihu
colors:
  brand: '#1772f6'
  brand-alt: '#18afff'
  foreground: '#191b1f'
  text-secondary: '#373a40'
  text-muted: '#8491a5'
  text-placeholder: '#81858f'
  ui-frame: '#535861'
  canvas: '#ffffff'
  page: '#f4f6f9'
  surface: '#fbfcfc'
  surface-alt: '#f8f8fa'
  commerce: '#ff7d55'
  vip: '#ce994f'
  vip-frame: '#f2ba6b'
  svip: '#142457'
  success: '#11a668'
  accent-purple: '#5a4df8'
  blue-light: '#80c1ff'
  neutral-mid: '#646464'
  neutral-line: '#d3d3d3'
  dark-text: '#c2c6cf'
  on-brand: '#ffffff'
typography:
  base:
    fontSize: 15px
    use: Dominant reading size on the home feed
  body:
    fontSize: 16px
    use: Column and article body
  control:
    fontSize: 14px
    use: Control and secondary label text
  caption:
    fontSize: 12px
    use: Metadata and counts
  lead:
    fontSize: 18px
    use: Column lead
  micro:
    fontSize: 11px
    use: Smallest observed step
rounded:
  sm: 3px
  md: 6px
  pill: 20px
  circle: 9999px
components:
  button-primary:
    type: button
    backgroundColor: '#1772f6'
    textColor: '#ffffff'
    rounded: 3px
    typography: 14px / 400
    hover: oklch(0.535218 0.21381 259.318)
    pressed: oklch(0.535218 0.21381 259.318)
    focus: oklch(0.581758 0.21381 259.318 / 0.3)
    use: Sign-in / register — 36px on the home feed, 34px in columns; focus draws a two-layer ring.
    height: 36px
    padding: 0px 16px
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#8491a5'
    rounded: 20px
    typography: 14px / 400
    hover: color(srgb 0.870588 0.876471 0.889412)
    pressed: color(srgb 0.870588 0.876471 0.889412)
    focus: oklch(0.581758 0.21381 259.318 / 0.3)
    use: Rounded utility control, 60px — hover shifts both fill and label; the same two-layer focus ring as the primary.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# Zhihu

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Zhihu; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/zhihu/DESIGN.md
