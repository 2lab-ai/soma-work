---
name: BASE
colors:
  prime-50: '#e0f3f4'
  prime-100: '#c6e9eb'
  prime-200: '#a6dddd'
  prime-300: '#7fd1cf'
  prime-400: '#59c4c0'
  prime-500: '#0bb7ae'
  prime-600: '#00a099'
  prime-700: '#00938b'
  prime-800: '#00827a'
  prime-900: '#105151'
  gray-50: '#f7f8f9'
  gray-100: '#edeef1'
  gray-200: '#dadce0'
  gray-300: '#c1c7d1'
  gray-400: '#9ba2ae'
  gray-500: '#838996'
  gray-600: '#636978'
  gray-700: '#45495b'
  gray-800: '#2e3242'
  gray-900: '#1e1f2a'
  pink: '#fc6589'
  foreground: '#233237'
  core-black: '#0d181e'
  canvas: '#ffffff'
  border-gray-lighter: '#a5acb6'
  inspiration-red: '#ff4600'
  inspiration-red-hover: '#de3b00'
  red-lighter: '#fff4f4'
  red-lighter-text: '#f87e7e'
  brown: '#a33e36'
typography:
  min:
    fontSize: 10px
    use: '--minimum-font-size, and the smallest rendered step'
  small:
    fontSize: 12px
    use: Fine print and captions
  body:
    fontSize: 14px
    use: The dominant rendered size — 35 elements
  base:
    fontSize: 16px
    use: Header buttons and lead copy
  lead:
    fontSize: 18px
    use: Section intros and the fixed bottom CTA
  title:
    fontSize: 20px
    use: The hero call-to-action label
  heading:
    fontSize: 22px
    use: Section headings
  display:
    fontSize: 28px
    use: The largest rendered step
rounded:
  sm: 4px
  lg: 16px
  pill: 999px
spacing:
  s8: 8
  s16: 16
  s24: 24
  s32: 32
  s40: 40
  s64: 64
  s72: 72
  s80: 80
  s120: 120
  s144: 144
components:
  button-login:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#233237'
    rounded: 0px
    height: 60px
    typography: 16px / 400
    hover: '#233237'
    pressed: '#233237'
    use: 'ログイン, 160×60 — a square white button that inverts entirely on hover: fill #233237, text #ffffff. transition: background-color 0.3s.'
  button-header-cta:
    type: button
    backgroundColor: '#fc6589'
    textColor: '#ffffff'
    rounded: 0px
    height: 60px
    typography: 16px / 400
    hover: rgba(255,255,255,0.08)
    pressed: rgba(255,255,255,0.08)
    use: 無料ではじめる, 160×60 — the pink header action. The button's own properties do not change; hover and pressed lay a white ::before at 8% opacity over the pink (re-checked 2026-09-26).
    padding: 0px
  button-hero-cta:
    type: button
    backgroundColor: '#fc6589'
    textColor: '#ffffff'
    rounded: 999px
    height: 70px
    typography: 20px / 700
    hover: rgba(255,255,255,0.08)
    pressed: rgba(255,255,255,0.08)
    use: 無料でショップを開設する, 432×70 — the same pink as a full pill, one size and two weights up. Hover and pressed add the same 8% white ::before, and an ::after picks up a background image (re-checked 2026-09-26).
fonts:
  roles:
    sans: TazuganeGothicStdN
    display: Gilroy
---

# BASE

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to BASE; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/base/DESIGN.md
