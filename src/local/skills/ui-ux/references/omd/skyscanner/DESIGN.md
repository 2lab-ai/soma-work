---
name: Skyscanner
colors:
  primary: '#0062e3'
  primary-hover: '#024daf'
  primary-deep: '#154679'
  brand-dark: '#05203c'
  canvas: '#ffffff'
  canvas-contrast: '#eff3f8'
  surface-low-contrast: '#f7f9fb'
  surface-subtle: '#e3f0ff'
  surface-highlight: '#e0e4e9'
  foreground: '#161616'
  muted: '#626971'
  on-primary: '#ffffff'
  line: '#c1c7cf'
  eco: '#0fa1a9'
  error: '#e70866'
  success: '#0c838a'
  warning: '#f55d42'
typography:
  display:
    fontSize: 64px
    fontWeight: 900
    lineHeight: 1.2
    use: Brand World display; very large display copy only
  hero-1:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.25
    use: Page hero headline (large)
  hero-2:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    use: Secondary hero / section heads
  heading-1:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.3
    use: Major headings
  heading-2:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.3
    use: Sub-section headings
  body-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: Large body / feature descriptions
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Secondary body, captions
  label:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.43
    use: Buttons and labels
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Fine print, metadata
rounded:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 24px
  full: 9999px
spacing:
  sm: 4
  md: 8
  base: 16
  lg: 24
  xl: 32
  xxl: 40
  xxxl: 64
  xxxxl: 96
components:
  button-primary:
    type: button
    backgroundColor: '#0062e3'
    textColor: '#ffffff'
    rounded: 8px
    height: 36px
    padding: 0px 16px
    typography: 16px / 400 Skyscanner Relative
    hover: '#024daf'
    use: Primary CTA — search, book, confirm
  button-secondary:
    type: button
    backgroundColor: '#e0e4e9'
    textColor: '#161616'
    rounded: 8px
    height: 36px
    padding: 0px 16px
    typography: 16px / 400 Skyscanner Relative
    hover: '#c1c7cf'
    use: Secondary actions
  button-featured:
    type: button
    backgroundColor: '#0062e3'
    textColor: '#ffffff'
    rounded: 8px
    height: 48px
    padding: 0px 16px
    typography: 16px / 400 Skyscanner Relative
    use: Large featured CTA (Large button variant)
  tab-active:
    type: tab
    backgroundColor: '#0062e3'
    textColor: '#ffffff'
    rounded: 100px
    padding: 0px 16px
    height: 36px
    typography: 16px / 400
    use: Active product tab (Flights, Hotels, Cars)
    active: 'bg #0062e3 text #ffffff'
  tab-inactive:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 100px
    padding: 0px 16px
    height: 36px
    border: rgba(255,255,255,0.5) 0px 0px 0px 1px inset
    use: Inactive product tab
  input-search:
    type: input
    backgroundColor: '#ffffff'
    border: none
    rounded: 12px
    padding: 0px 16px
    height: 72px
    typography: 16px / 400 Skyscanner Relative
    use: Flight/hotel search field block
  card-default:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    shadow: rgba(0,0,0,0.08) 0px 4px 8px 0px, rgb(230,233,235) 0px 0px 0px 1px
    use: Standard content card
  badge-info:
    type: badge
    backgroundColor: '#e3f0ff'
    textColor: '#0062e3'
    rounded: 6px
    padding: 4px 8px
    typography: 12px / 400
    use: Status / informational pill
  toggle-on:
    type: toggle
    backgroundColor: '#0062e3'
    textColor: '#ffffff'
    use: Toggle/checkbox in 'on' state
  chip-filter:
    type: badge
    backgroundColor: '#05203c'
    textColor: '#ffffff'
    rounded: 8px
    border: '1px solid #c1c7cf'
    padding: 0px 12px
    height: 32px
    typography: 14px / 400
    use: Filter chip in active/selected state
fonts:
  roles:
    sans: '''Skyscanner Relative'''
    serif: Larken
---

# Skyscanner

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Skyscanner; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/skyscanner/DESIGN.md
