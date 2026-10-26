---
name: Sendbird
colors:
  primary: '#742ddd'
  primary-hover: '#6211c8'
  primary-active: '#491389'
  brand: '#742ddd'
  canvas: '#ffffff'
  foreground: '#0d0d0d'
  body: '#424242'
  muted: '#eeeeee'
  on-primary: '#ffffff'
  success: '#259c72'
  error: '#de360b'
  info: '#adc9ff'
  surface: '#f2f3f7'
  hairline: '#e3e5ef'
  border-light: '#d1d1d1'
  ink-dark: '#0d0d0d'
typography:
  display-serif:
    fontSize: 72px
    fontWeight: 500
    use: Marketing hero headline (serif)
  body-lg:
    fontSize: 18px
    fontWeight: 400
    use: Marketing body text
  nav:
    fontSize: 16px
    fontWeight: 500
    use: Marketing nav links
  body:
    fontSize: 14px
    fontWeight: 400
    use: UIKit message text and labels
  label:
    fontSize: 14px
    fontWeight: 600
    use: UIKit labels, button text
  cta:
    fontSize: 13px
    fontWeight: 600
    use: Marketing pill CTA text
rounded:
  sm: 4px
  md: 8px
  lg: 24px
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
    backgroundColor: '#742ddd'
    textColor: '#ffffff'
    rounded: '4'
    typography: 13px / 400 Roboto
    hover: '#6211c8'
    pressed: '#491389'
    focus: '1px solid #ffffff'
    use: UIKit primary action — 40px tall.
  button-secondary:
    type: button
    textColor: '#742ddd'
    rounded: '4'
    typography: 13px / 400 Roboto
    hover: '1px solid #742ddd'
    pressed: '1px solid #742ddd'
    use: UIKit secondary action — transparent fill, 40px tall.
  button-danger:
    type: button
    backgroundColor: '#de360b'
    textColor: '#ffffff'
    rounded: '4'
    typography: 13px / 400 Roboto
    hover: '#bf0711'
    pressed: '#9d091e'
    use: UIKit destructive action — 40px tall.
  button-disabled:
    type: button
    backgroundColor: '#e0e0e0'
    textColor: '#101010'
    rounded: '4'
    disabled: '#e0e0e0'
    use: UIKit unavailable action — palette swap, 40px tall.
  input:
    type: input
    backgroundColor: '#FFFFFF'
    textColor: rgba(0,0,0,0.87)
    border: 1px solid rgba(0,0,0,0.12)
    rounded: 4px
    padding: 7px 12px
    typography: 14px / 400
    focus: 'border #742DDD + 0 0 0 1px #742DDD'
    use: UIKit text field
  bubble-outgoing:
    type: listItem
    backgroundColor: '#742DDD'
    textColor: '#FFFFFF'
    use: Outgoing message bubble, right-aligned, max 400px
  bubble-incoming:
    type: listItem
    backgroundColor: '#EEEEEE'
    textColor: rgba(0,0,0,0.87)
    use: Incoming message bubble, left-aligned, 40px avatar
  button-pill-marketing:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 8px
    height: 42px
    typography: 18px / 700
    hover: '#ffffff'
    pressed: '#ffffff'
    focus: '#0d0d0d'
    use: 'Marketing CTA pill (Contact sales), 139×42 in the header. The element itself is transparent — the fill is painted by a child — so only the text, geometry and states are measured. Hover and pressed change nothing; focus draws a #0d0d0d 2px solid outline.'
  chip:
    type: badge
    backgroundColor: '#F2F3F7'
    textColor: '#0D0D0D'
    border: '1px solid #E3E5EF'
    rounded: 8px
    height: 50px
    padding: 8px 12px
    typography: 18px / 400
    use: Marketing neutral selector / utility control
  checkbox:
    type: toggle
    rounded: '2'
    focus: '#742ddd'
    use: UIKit checkbox — 22px box; focus fills brand purple.
  toggle:
    type: toggle
    backgroundColor: '#bdbdbd'
    rounded: '12'
    focus: '#742ddd'
    use: 'UIKit switch — 20px track, off #bdbdbd.'
fonts:
  roles:
    sans: Helvetica Now Text
    mono: system-ui
---

# Sendbird

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Sendbird; reproduced for educational reference. Full prose: https://oh-my-design.kr/sendbird/design.md
