---
name: Celonis
colors:
  accent-green: '#5cfe50'
  accent-secondary: '#04cd24'
  black: '#000000'
  header-button: '#1d1d1d'
  header-button-hover: '#4d4d4d'
  canvas: '#ffffff'
  background-secondary: '#f5f5f5'
  background-tertiary: '#e5e5e5'
  background-quaternary: '#cbcbcb'
  background-quinary: '#767676'
  foreground: '#000000'
  text-mid: '#666666'
  text-low: '#8e8d8d'
  success: '#0b9e23'
  success-bg: '#d5ffd1'
  danger: '#bf281b'
  danger-bg: '#ffdfdc'
typography:
  display:
    fontSize: 80px
    fontWeight: 400
    use: section headlines (--fnd-typography-heading-xl 5rem, -3px tracking)
  body:
    fontSize: 14px
    fontWeight: 400
    use: header buttons
rounded:
  s: 2px
  m: 4px
  l: 8px
components:
  button-primary:
    type: button
    backgroundColor: '#5cfe50'
    textColor: '#000000'
    rounded: 2px
    height: 40px
    padding: 0 16px
    typography: 14px / 400
    hover: inset 0 0 0 1000px rgba(0,0,0,0.2)
    focus: inset 0 0 0 1000px rgba(0,0,0,0.2)
    use: Try for free — neon green with black text; hover and focus darken it with a 20% black inset shadow.
    pressed: shadow rgba(0, 0, 0, 0.2) 0px 0px 0px 1000px inset (:hover + :active)
  link-cta:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    height: 24px
    typography: 18px / 400
    hover: 'underline #ffffff'
    use: 'Discover our solutions on the black hero — white text that underlines on hover while a green #5cfe50 ::before fades in.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Poppins
---

# Celonis

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Celonis; reproduced for educational reference. Full prose: https://oh-my-design.kr/celonis/design.md
