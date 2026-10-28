---
name: Spendesk
colors:
  brand-deep-purple: '#7136ed'
  brand-carbon: '#191b1b'
  brand-grolive: '#f3f4ef'
  purple: '#5d21d2'
  purple-hover: '#4b1baf'
  purple-ultradark: '#27175c'
  purple-ultralight: '#f7f4fd'
  lavender: '#9477f3'
  periwinkle: '#b3bffa'
  mint: '#91d69f'
  teal: '#4ac8c6'
  pink: '#e473ff'
  salmon: '#ffa38a'
  error: '#f04c74'
  foreground: '#191b1b'
  text-secondary: '#636363'
  canvas: '#ffffff'
  neutral-100: '#f7f7f7'
  neutral-400: '#cccccc'
typography:
  display:
    fontSize: 64px
    fontWeight: 500
    use: hero H1; H2 48px/500
  button:
    fontSize: 16px
    fontWeight: 600
    use: header buttons
rounded:
  md: 8px
components:
  button-primary:
    type: button
    backgroundColor: '#7136ed'
    textColor: '#ffffff'
    rounded: 8px
    height: 44px
    padding: 14px 20px
    typography: 16px / 600
    hover: '#7136ed'
    pressed: '#7136ed'
    use: Book a demo — brand deep purple; :hover matched and the button's own values did not change.
  button-secondary:
    type: button
    backgroundColor: '#f3f4ef'
    textColor: '#191b1b'
    rounded: 8px
    height: 46px
    padding: 14px 20px
    typography: 16px / 600
    hover: '#f3f4ef'
    pressed: '#f3f4ef'
    use: Login — grolive with carbon text and a 10% carbon border; no hover change.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Roobert
    sans: Inter
---

# Spendesk

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Spendesk; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/spendesk/DESIGN.md
