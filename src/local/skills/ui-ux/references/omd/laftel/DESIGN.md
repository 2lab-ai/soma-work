---
name: Laftel
colors:
  primary: '#816bff'
  primary-hover: '#6e58ff'
  brand: '#816bff'
  canvas: '#ffffff'
  foreground: '#121212'
  muted: '#8a8a8a'
  surface: '#242537'
  hairline: '#eeeeee'
  accent-wash: '#f0edff'
  error: '#f16361'
  on-primary: '#ffffff'
typography:
  title-xxl:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.5
    use: Largest display title
  title-xl:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: Section title
  title-l:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.5
    use: Sub-section title
  title-m:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: Card / block title
  title-s:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Small title
  text-l:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    use: Large body / button label
  text-m:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Default body
  text-s:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.5
    use: Nav link, toast, small label
  text-xs:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Metadata
  text-xxs:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Fine print
rounded:
  sm: 4px
  md: 4px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#816bff'
    textColor: '#ffffff'
    rounded: 4px
    height: 56px
    padding: 0 18px
    typography: 18px / 700
    states: 'hover #6e58ff'
    use: Primary CTA (md)
  button-primary-sm:
    type: button
    backgroundColor: '#816bff'
    textColor: '#ffffff'
    rounded: 4px
    height: 48px
    padding: 0 20px
    typography: 16px / 700
    use: Primary CTA (sm)
  button-slight:
    type: button
    backgroundColor: '#f0edff'
    textColor: '#816bff'
    rounded: 4px
    height: 56px
    typography: 18px / 700
    states: 'hover #d9d3ff'
    use: Secondary action
  button-disabled:
    type: button
    backgroundColor: '#eeeeee'
    textColor: '#8a8a8a'
    rounded: 4px
    height: 56px
    use: Disabled action
  nav-bar:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#121212'
    height: 64px
    padding: 0 50px
    border: '1px solid #eeeeee'
    typography: 14px / 700
    active: 'link color #816bff'
    use: Desktop nav — active/hover link purple
  badge-notification:
    type: badge
    backgroundColor: '#816bff'
    textColor: '#ffffff'
    rounded: 9999px
    height: 17px
    typography: 10px / 700
    use: Notification count badge
  toast:
    type: toast
    backgroundColor: '#242537'
    textColor: '#ffffff'
    rounded: 4px
    padding: 16px 12px
    height: 48px
    typography: 14px / 400
    use: 'Default toast (#000000 light / #242537 dark)'
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# Laftel

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Laftel; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/laftel/DESIGN.md
