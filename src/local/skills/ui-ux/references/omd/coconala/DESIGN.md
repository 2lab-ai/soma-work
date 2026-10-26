---
name: coconala
colors:
  brand: '#00a38d'
  brand-hover: '#00866e'
  brand-press: '#006650'
  foreground: '#202a2e'
  text-secondary: '#4d656d'
  label: '#333333'
  link: '#0977e5'
  canvas: '#ffffff'
  surface: '#f3f4f5'
  surface-strong: '#e7eaeb'
  border: '#ced4d6'
  green-200: '#7ac9bb'
  blue-500: '#0098ff'
  orange-500: '#ff9900'
  red-500: '#ff3b30'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    use: system Japanese stack — Hiragino Kaku Gothic ProN, Meiryo, Helvetica Neue
rounded:
  sm: 4px
  md: 6px
components:
  button-login:
    type: button
    backgroundColor: transparent
    textColor: '#00a38d'
    border: '#00a38d'
    rounded: 4px
    height: 32px
    padding: 1px 12px
    typography: 11px / 600
    hover: rgba(0,163,141,0.04)
    pressed: rgba(0,163,141,0.12)
    focus: rgba(0,163,141,0.12)
    use: ログイン in the header — green label with a 50% green border; hover tints the fill 4%, press and focus 12%.
  button-signup:
    type: button
    backgroundColor: '#00a38d'
    textColor: '#ffffff'
    border: '#00a38d'
    rounded: 4px
    height: 32px
    padding: 1px 12px
    typography: 11px / 600
    hover: '#00866e'
    pressed: '#006650'
    focus: '#006650'
    use: 会員登録 in the header — the green fill stepping --green-400 → --green-600 → --green-800.
  tile-category:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    height: 108px
    typography: 14px / 300
    hover: opacity 0.7
    pressed: 'fg #363636'
    use: 'One of 19 category tiles (デザイン制作 here) — icon and #333333 label; hover fades the tile to 70% opacity.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Hiragino Kaku Gothic ProN
---

# coconala

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to coconala; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/coconala/DESIGN.md
