---
name: CrowdWorks
colors:
  primary: '#006ab6'
  primary-500: '#239ae7'
  primary-50: '#e3f2fb'
  link: '#004980'
  brand-cta: '#f26731'
  orange-500: '#f0510f'
  orange-700: '#d54507'
  text-orange: '#cc4900'
  foreground: '#353d48'
  text-gray: '#617084'
  disabled: '#cfd4da'
  line-gray: '#afb7c1'
  canvas: '#ffffff'
  surface-gray-light: '#ecedf0'
  surface-gray-bright: '#f9fafb'
  surface-blue-light: '#e7f1fa'
  surface-blue-bright: '#f5f9ff'
  accent: '#cb2442'
  danger: '#c92b36'
  danger-light: '#feecf0'
  success: '#177835'
  success-light: '#e6f4e9'
  warning: '#8f6c00'
  warning-light: '#fef9e4'
  info: '#0467a2'
  info-light: '#e0f2fa'
  visited: '#9c27b0'
  aicw-primary: '#5628a8'
  aicw-primary-dark: '#4b2485'
  aicw-secondary: '#0a7093'
  aicw-tertiary: '#32d4af'
typography:
  xxxs:
    fontSize: 10px
    use: '--font-size-10; --single-xxxs / --paragraph-xxxs'
  xxs:
    fontSize: 12px
    use: '--font-size-12; the dominant rendered size, 190 elements'
  xs:
    fontSize: 14px
    use: '--font-size-14; header button labels'
  s:
    fontSize: 16px
    use: '--font-size-16; the wide call-to-action label'
  m:
    fontSize: 18px
    use: '--font-size-18'
  l:
    fontSize: 22px
    use: '--font-size-22'
  xl:
    fontSize: 28px
    use: '--font-size-28'
  xxl:
    fontSize: 37px
    use: '--font-size-37; the largest --single/--paragraph step'
  display:
    fontSize: 56px
    use: '--font-size-56'
  hero:
    fontSize: 112px
    use: '--font-size-112; the largest published size'
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 16px
  xl: 24px
  xxl: 32px
  pill: 10000px
spacing:
  s2: 2
  s3: 3
  s4: 4
  s8: 8
  s12: 12
  s16: 16
  s24: 24
  s32: 32
  s40: 40
  s48: 48
  s56: 56
  s64: 64
  s72: 72
  s80: 80
components:
  button-cta:
    type: button
    backgroundColor: '#f26731'
    textColor: '#ffffff'
    rounded: 4px
    height: 48px
    padding: 0 16px
    typography: 16px / 700
    hover: layer rgba(0,0,0,0.1)
    pressed: layer rgba(0,0,0,0.1)
    use: 無料ではじめる — the wide call to action, 312×48. Hover and press lay a 10% black gradient over the orange (background-image); the fill value itself does not change. Focus shows the same layer and the browser's ring.
    focus: background-image linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.1)), browser default focus ring (outline auto) on :focus-visible
  button-signup:
    type: button
    backgroundColor: '#f26731'
    textColor: '#ffffff'
    rounded: 4px
    height: 40px
    padding: 0 16px
    typography: 14px / 700
    hover: layer rgba(0,0,0,0.1)
    pressed: layer rgba(0,0,0,0.1)
    use: 会員登録（無料） in the header, 130×40 — the same orange at the header size, with the same 10% black layer on hover and press.
  button-login:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#353d48'
    border: '1px solid #afb7c1'
    rounded: 4px
    height: 40px
    padding: 0 16px
    typography: 14px / 700
    hover: layer rgba(0,0,0,0.05)
    pressed: layer rgba(0,0,0,0.05)
    use: ログイン, 89×40 — the outline twin; hover and press lay a 5% black layer over the white.
  button-google:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#353d48'
    border: '1px solid #d6d6d6'
    rounded: 4px
    height: 32px
    padding: 4px 16px 4px 8px
    typography: 12px / 700
    shadow: rgba(163,162,162,0.2) -1px 2px 4px
    hover: layer rgba(0,0,0,0.05)
    pressed: layer rgba(0,0,0,0.05)
    use: Sign in with Google, 148×32 — the only measured control with a shadow, cast down and to the left; hover and press lay a 5% black layer.
  link-guide:
    type: button
    backgroundColor: '#f7f9fa'
    textColor: '#000000'
    border: '1px solid #ecedf0'
    rounded: 0px
    height: 53px
    padding: 16px 32px
    typography: 11px / 700
    hover: rgba(32,34,39,.05)
    pressed: rgba(32,34,39,.05)
    use: はじめての方へ, a 360×53 guide row with a top rule only — the one measured control that responds, washing to ink at 5% on hover and press.
  input-email:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#353d48'
    border: '1px solid #bcc5cc'
    rounded: 4px
    height: 45px
    padding: 4px
    typography: 14px / 400
    hover: '#ffffff'
    pressed: '#ffffff'
    focus: '#ffffff'
    use: The email field, 291×45. Every property is identical at rest, hover, pressed and focus — including under :focus-visible, where it shows no ring at all.
fonts:
  roles:
    sans: Noto Sans JP
---

# CrowdWorks

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to CrowdWorks; reproduced for educational reference. Full prose: https://oh-my-design.kr/crowdworks/design.md
