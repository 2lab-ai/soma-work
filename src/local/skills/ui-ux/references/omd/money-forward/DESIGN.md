---
name: Money Forward
colors:
  primary: '#3b7de9'
  primary-hover: '#0054ac'
  brand: '#3b7de9'
  canvas: '#ffffff'
  surface: '#ecf2fd'
  foreground: '#333333'
  muted: '#999999'
  on-primary: '#ffffff'
  hairline: '#d4d8dd'
  error: '#d0021b'
  success: '#65ab51'
  warning-bg: '#fcf8e3'
  warning-text: '#8a6d3b'
  error-bg: '#ffeeeb'
typography:
  xSmall:
    fontSize: 10px
    use: Fine print, dense table footnotes
  small:
    fontSize: 12px
    use: Captions, helper text
  middle:
    fontSize: 13px
    use: Secondary labels, table cells
  large:
    fontSize: 14px
    fontWeight: 400
    use: Body / button default
  xlarge:
    fontSize: 16px
    use: Emphasized body
  xxlarge:
    fontSize: 18px
    fontWeight: 700
    use: Subheadings
  xxxLarge:
    fontSize: 20px
    fontWeight: 700
    use: Section headings
  xxxxLarge:
    fontSize: 24px
    fontWeight: 700
    use: Page headings
rounded:
  sm: 4px
  md: 4px
  lg: 4px
  full: 9999px
components:
  button-primary:
    type: button
    backgroundColor: linear-gradient(to bottom,#3b7de9,#0054ac)
    textColor: '#ffffff'
    border: 1px solid rgba(0,0,0,0.15)
    rounded: 4px
    height: 32px
    padding: 0 12px
    typography: 14px / 400
    states: hover gradient flips, active 0 0 2px rgba(212,216,221,0.3)
    use: Single primary action per screen
  button-default:
    type: button
    backgroundColor: linear-gradient(to bottom,#ffffff,#ecf2fd)
    textColor: '#333333'
    border: '1px solid #d4d8dd'
    rounded: 4px
    typography: 14px / 400
    states: hover gradient flips
    use: Secondary / cancel actions
  button-danger:
    type: button
    backgroundColor: linear-gradient(to bottom,#ffffff,#ecf2fd)
    textColor: '#d0021b'
    border: '1px solid #d4d8dd'
    rounded: 4px
    use: Destructive actions, danger in text not fill
  button-disabled:
    type: button
    backgroundColor: '#d4d8dd'
    textColor: '#999999'
    border: 1px solid rgba(0,0,0,0.1)
    rounded: 4px
    use: Unavailable actions
  block:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #d4d8dd'
    rounded: 4px
    use: Content panel / card container
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #d4d8dd'
    rounded: 4px
    focus: 'border #3b7de9'
    use: Form fields
  notice-error:
    type: card
    backgroundColor: '#ffeeeb'
    textColor: '#d0021b'
    rounded: 4px
    use: Error / danger banner
  notice-warning:
    type: card
    backgroundColor: '#fcf8e3'
    textColor: '#8a6d3b'
    use: Caution banner
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Noto Sans JP
    mono: Noto Sans JP
---

# Money Forward

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Money Forward; reproduced for educational reference. Full prose: https://oh-my-design.kr/money-forward/design.md
