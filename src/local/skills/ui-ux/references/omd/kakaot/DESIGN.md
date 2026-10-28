---
name: Kakao T
colors:
  primary: '#fee500'
  primary-hover: '#f2d900'
  brand: '#fee500'
  canvas: '#ffffff'
  foreground: '#191919'
  muted: '#76787a'
  on-primary: '#191919'
  surface: '#f5f6f7'
  hairline: '#e5e6e8'
  body: '#4b4f54'
  text-strong: '#26282b'
  text-tertiary: '#a2a4a6'
  success: '#0fb882'
  info: '#3478f6'
  warning: '#ff8a00'
  error: '#f5444c'
  black: '#000000'
typography:
  display-hero:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.3
    use: Marketing hero, onboarding
  heading-large:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.35
    use: Sheet headers
  heading:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.4
    use: Card titles, vehicle-class headers
  subtitle:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: List headers, fare summary label
  body-large:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Descriptions, address detail
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, trip metadata
  label:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Button labels
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Timestamps, fine print
  fare-display:
    fontSize: 24px
    fontWeight: 700
    use: Estimated/final fare, tabular numerals
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
components:
  button-primary:
    type: button
    backgroundColor: '#fee500'
    textColor: '#191919'
    rounded: 12px
    padding: 14px 20px
    height: 52px
    typography: 16px / 600
    states: 'pressed #f2d900'
    disabled: 'bg #f5f6f7 fg #a2a4a6'
    use: Primary CTA 호출하기 / 결제하기
  button-dark:
    type: button
    backgroundColor: '#191919'
    textColor: '#ffffff'
    rounded: 12px
    padding: 14px 20px
    typography: 16px / 600
    use: Strong action where yellow too loud 로그인 / 다음
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#26282b'
    border: '1px solid #d1d3d5'
    rounded: 12px
    padding: 14px 20px
    typography: 16px / 600
    use: Secondary action 취소
  button-danger:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#f5444c'
    border: '1px solid #f5444c'
    rounded: 12px
    padding: 14px 20px
    typography: 16px / 600
    use: Destructive 호출 취소
  input-search:
    type: input
    backgroundColor: '#f5f6f7'
    textColor: '#26282b'
    rounded: 12px
    padding: 14px 16px
    typography: 16px / 400
    focus: '1px border #191919'
    use: 어디로 갈까요? destination search
  input-error:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#26282b'
    border: '1px solid #f5444c'
    rounded: 12px
    padding: 14px 16px
    typography: 16px / 400
    use: Invalid input
  card-vehicle:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e5e6e8'
    rounded: 12px
    padding: 16px
    active: '2px border #191919 + yellow icon accent'
    use: Vehicle-class selection rows
  card-trip:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 20px
    shadow: 0px 2px 12px rgba(0,0,0,0.08)
    use: Active-trip summary, ride receipt
  badge-status:
    type: badge
    backgroundColor: '#f5f6f7'
    textColor: '#4b4f54'
    rounded: 999px
    padding: 4px 12px
    typography: 12px / 600
    use: Filter chips, vehicle tags
  badge-live:
    type: badge
    backgroundColor: rgba(15,184,130,0.12)
    textColor: '#0fb882'
    rounded: 999px
    padding: 4px 10px
    typography: 12px / 700
    use: 도착 / 운행 중 status pill
  dialog-sheet:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#191919'
    rounded: 20px
    padding: 20px
    shadow: 0px -4px 16px rgba(0,0,0,0.10)
    use: Persistent bottom sheet over the map, 36x4px handle
  tab-bottom:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#a2a4a6'
    border: '1px solid #e5e6e8'
    typography: 11px / 500
    active: 'text/icon #191919'
    use: 홈 / 이용내역 / 결제 / 전체 nav
  toast-snackbar:
    type: toast
    backgroundColor: '#26282b'
    textColor: '#ffffff'
    rounded: 12px
    padding: 12px 16px
    shadow: 0px 4px 12px rgba(0,0,0,0.16)
    typography: 14px / 500
    use: Transient feedback, 3s auto-dismiss
fonts:
  roles:
    sans: Pretendard
    mono: SF Mono
---

# Kakao T

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kakao T; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kakaot/DESIGN.md
