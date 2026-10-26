---
name: Toss
description: Toss product (TDS Mobile) and toss.im marketing surfaces, kept separate. Values are limited to current computed styles and current official TDS documentation; unresolved values are omitted.
colors:
  primary: '#3182f6'
  primary-hover: '#2272eb'
  canvas: '#ffffff'
  foreground: '#191f28'
  body: '#4e5968'
  muted: '#8b95a1'
  surface: '#f2f4f6'
  border: '#e5e8eb'
  on-primary: '#ffffff'
  weak-background: '#e8f3ff'
  weak-foreground: '#1b64da'
  danger: '#e42939'
  grey50: '#f9fafb'
  grey100: '#f2f4f6'
  grey200: '#e5e8eb'
  grey300: '#d1d6db'
  grey400: '#b0b8c1'
  grey500: '#8b95a1'
  grey600: '#6b7684'
  grey700: '#4e5968'
  grey800: '#333d4b'
  grey900: '#191f28'
  blue50: '#e8f3ff'
  blue100: '#c9e2ff'
  blue200: '#90c2ff'
  blue300: '#64a8ff'
  blue400: '#4593fc'
  blue500: '#3182f6'
  blue600: '#2272eb'
  blue700: '#1b64da'
  blue800: '#1957c2'
  blue900: '#194aa6'
  red50: '#ffeeee'
  red100: '#ffd4d6'
  red200: '#feafb4'
  red300: '#fb8890'
  red400: '#f66570'
  red500: '#f04452'
  red600: '#e42939'
  red700: '#d22030'
  red800: '#bc1b2a'
  red900: '#a51926'
  orange50: '#fff3e0'
  orange100: '#ffe0b0'
  orange200: '#ffcd80'
  orange300: '#ffbd51'
  orange400: '#ffa927'
  orange500: '#fe9800'
  orange600: '#fb8800'
  orange700: '#f57800'
  orange800: '#ed6700'
  orange900: '#e45600'
  yellow50: '#fff9e7'
  yellow100: '#ffefbf'
  yellow200: '#ffe69b'
  yellow300: '#ffdd78'
  yellow400: '#ffd158'
  yellow500: '#ffc342'
  yellow600: '#ffb331'
  yellow700: '#faa131'
  yellow800: '#ee8f11'
  yellow900: '#dd7d02'
  green50: '#f0faf6'
  green100: '#aeefd5'
  green200: '#76e4b8'
  green300: '#3fd599'
  green400: '#15c47e'
  green500: '#03b26c'
  green600: '#02a262'
  green700: '#029359'
  green800: '#028450'
  green900: '#027648'
  teal50: '#edf8f8'
  teal100: '#bce9e9'
  teal200: '#89d8d8'
  teal300: '#58c7c7'
  teal400: '#30b6b6'
  teal500: '#18a5a5'
  teal600: '#109595'
  teal700: '#0c8585'
  teal800: '#097575'
  teal900: '#076565'
  purple50: '#f9f0fc'
  purple100: '#edccf8'
  purple200: '#da9bef'
  purple300: '#c770e4'
  purple400: '#b44bd7'
  purple500: '#a234c7'
  purple600: '#9128b4'
  purple700: '#8222a2'
  purple800: '#73228e'
  purple900: '#65237b'
typography:
  h1:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 54px
    fontFamily: Toss Product Sans, IBM Plex Sans, Pretendard Variable, sans-serif
  h2:
    fontSize: 30px
    fontWeight: 600
    lineHeight: 45px
    fontFamily: Toss Product Sans, IBM Plex Sans, Pretendard Variable, sans-serif
  h3:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 36px
    fontFamily: Toss Product Sans, IBM Plex Sans, Pretendard Variable, sans-serif
  h4:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 33px
    fontFamily: Toss Product Sans, IBM Plex Sans, Pretendard Variable, sans-serif
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    fontFamily: Toss Product Sans, IBM Plex Sans, Pretendard Variable, sans-serif
  body-small:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 21px
    fontFamily: Toss Product Sans, IBM Plex Sans, Pretendard Variable, sans-serif
  t1:
    fontSize: 30px
    lineHeight: 40px
  st1:
    fontSize: 29px
    lineHeight: 38px
  st2:
    fontSize: 28px
    lineHeight: 37px
  st3:
    fontSize: 27px
    lineHeight: 36px
  t2:
    fontSize: 26px
    lineHeight: 35px
  st4:
    fontSize: 25px
    lineHeight: 34px
  st5:
    fontSize: 24px
    lineHeight: 33px
  st6:
    fontSize: 23px
    lineHeight: 32px
  t3:
    fontSize: 22px
    lineHeight: 31px
  st7:
    fontSize: 21px
    lineHeight: 30px
  t4:
    fontSize: 20px
    lineHeight: 29px
  st8:
    fontSize: 19px
    lineHeight: 28px
  st9:
    fontSize: 18px
    lineHeight: 27px
  t5:
    fontSize: 17px
    lineHeight: 25.5px
  st10:
    fontSize: 16px
    lineHeight: 24px
  t6:
    fontSize: 15px
    lineHeight: 22.5px
  st11:
    fontSize: 14px
    lineHeight: 21px
  t7:
    fontSize: 13px
    lineHeight: 19.5px
  st12:
    fontSize: 12px
    lineHeight: 18px
  st13:
    fontSize: 11px
    lineHeight: 16.5px
rounded:
  sm: 4px
  md: 6px
  button-small: 8px
  button-medium: 10px
  button-large: 14px
  button-xlarge: 16px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 16
  xl: 24
  xxl: 32
components:
  tds-button:
    type: button
    backgroundColor: '#3182f6'
    textColor: '#ffffff'
    rounded: 16px
    height: 56px
    padding: 0 20px
    typography: 17px / 600
    pressed: scale(0.96); 56px renders 54px, fill unchanged
    focus: '0 0 0 1px #8ac0ff, 0 0 0 3px #b8d9ff ring on :focus-visible'
    states: fill or weak; primary, danger, light, or dark; loading, disabled, pressed, and keyboard focus. Hover produces no observable change on the official component page — the press feedback is geometric, not tonal
    use: TDS Mobile xlarge primary action
  text-field:
    type: input
    states: box, line, big, hero; focus, error, disabled, read-only
    use: TDS Mobile text entry with help or error text
  badge:
    type: badge
    states: fill or weak; xsmall, small, medium, large; semantic color variants
    use: TDS Mobile status or category label; not an action
  agreement:
    type: toggle
    states: checked, unchecked, disabled, and nested agreement hierarchy
    use: TDS Mobile terms selection in v3 and v4 surfaces
  marketing-primary:
    type: button
    backgroundColor: '#e8f3ff'
    textColor: '#1b64da'
    rounded: 7px
    height: 40px
    padding: 11px 16px
    typography: 15px / 600
    states: default observed; hover not captured in the retained evidence bundle
    use: toss.im light-blue marketing CTA
  marketing-dark:
    type: button
    backgroundColor: rgba(0, 12, 30, 0.8)
    textColor: '#ffffff'
    rounded: 7px
    height: 46px
    padding: 11px 16px
    typography: 17px / 600
    states: default observed; hover not captured in the retained evidence bundle
    use: toss.im app-store style CTA
fonts:
  roles:
    sans: Toss Product Sans
  faces:
    Toss Product Sans:
      scripts:
        - hangul
        - latin
      evidence:
        - official-product-use
        - live-surface-use
      distribution: none-asserted
      substitutes:
        latin:
          family: IBM Plex Sans
          provider: google
          label: substitute — not the brand face
        hangul:
          family: Pretendard Variable
          provider: other
          label: substitute — not the brand face
    Tossface:
      evidence:
        - declared-only
  safeDefaults:
    hangul:
      - Noto Sans KR
    latin:
      - Noto Sans
---

# Toss

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Toss; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/toss/DESIGN.md
