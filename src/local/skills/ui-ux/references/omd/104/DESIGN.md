---
name: 104人力銀行
colors:
  primary: '#ff9100'
  primary-deep: '#ff7800'
  teal: '#00afb8'
  teal-soft: '#dbf7f7'
  teal-dark: '#39c8d0'
  canvas: '#ffffff'
  surface: '#eeeeee'
  foreground: '#292929'
  muted: '#7e7e7e'
  hairline: '#dddddd'
  link: '#1654b9'
  on-primary: '#ffffff'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Repeated public home and company-page text; operating-system stack, not a named 104 UI family
  label:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 2.14
    use: Observed compact action and navigation labels
  heading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: Observed public home section headings only
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 800px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 12
  xl: 16
  xxl: 20
components:
  search-action:
    type: button
    backgroundColor: '#ff9100'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 12px
    typography: 18px/700/42px operating-system stack
    states: default appearance from the 2026-07-13 capture; hover, pressed and keyboard focus measured by a live state probe on 2026-10-16
    use: Observed home navigation-search action
    height: 46px
    hover: 'bg #ff7800'
    pressed: 'bg #ff7800 with a 3.2px rgba(33, 37, 41, 0.5) ring (:hover + :active)'
    focus: 'bg #d97b00, border #cc7400 on :focus-visible; no outline drawn'
  outline-action:
    type: button
    textColor: '#ff9100'
    border: '1px #ff9100'
    rounded: 4px
    padding: 0px 12px
    typography: 14px/700/30px operating-system stack
    states: default static selector observed; interaction capture recorded 0, so no changed state values are published
    use: Observed compact public home action
  topic-tab:
    type: tab
    textColor: '#7e7e7e'
    rounded: 4px
    padding: 8px 16px
    typography: 16px/700/24px operating-system stack
    states: static non-active appearance observed; interaction capture recorded 0, so no transition values are published
    use: Observed home topic-navigation item
  active-topic-tab:
    type: tab
    textColor: '#ff7800'
    rounded: 4px
    padding: 8px 16px
    typography: 16px/700/24px operating-system stack
    states: static active appearance observed; interaction capture recorded 0, so no transition values are published
    use: Observed static active home topic-navigation item
  company-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #dddddd'
    rounded: 12px
    padding: 16px
    typography: 14px/400/16px operating-system stack
    use: Observed home content-card container
  login-dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#292929'
    rounded: 8px
    shadow: rgba(135, 135, 135, 0.4) 0px 2px 24px 0px
    use: Observed public login-prompt dialog shell
---

# 104人力銀行

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 104人力銀行; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/104/DESIGN.md
