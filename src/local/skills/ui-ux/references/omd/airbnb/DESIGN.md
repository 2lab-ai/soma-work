---
name: Airbnb
colors:
  primary: '#ff385c'
  canvas: '#ffffff'
  foreground: '#222222'
  secondary: '#6a6a6a'
  disabled: '#c1c1c1'
  surface: '#f2f2f2'
  surface-soft: '#ebebeb'
  divider: '#dddddd'
typography:
  title:
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.18
    use: Repeated public marketplace section heading
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Marketplace body and list text
  action:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.29
    use: Marketplace tabs and compact actions
  reading:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Help article body and long-form list content
  newsroom:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.56
    use: Newsroom editorial copy
rounded:
  control: 8px
  search: 32px
  card: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 32
components:
  hosting-action:
    type: button
    backgroundColor: transparent
    textColor: '#222222'
    rounded: 20px
    padding: 11px 12px
    height: 40px
    typography: 14px / 500
    states: pressed observed
    use: Current public hosting entry action
  category-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#6a6a6a'
    rounded: 8px
    padding: 0 16px
    typography: 14px / 500
    states: 'selected and tab-selected observed; selected text resolves to #222222'
    use: Current public category navigation
  icon-action:
    type: button
    backgroundColor: '#f2f2f2'
    textColor: '#222222'
    rounded: 9999px
    size: 28px
    states: hover and pressed observed
    use: Current compact circular marketplace control
    height: 40px
    padding: 0px
    typography: 14px / 400
    pressed: transform matrix(0.95, 0, 0, 0.95, 0, 0) (+1 nested-layer changes) (:hover + :active)
  disabled-icon-action:
    type: button
    backgroundColor: '#f2f2f2'
    textColor: '#c1c1c1'
    rounded: 9999px
    size: 28px
    states: disabled, focus, hover, and pressed captured
    use: Disabled compact circular marketplace control
  search-shell:
    type: input
    backgroundColor: '#ebebeb'
    textColor: '#222222'
    rounded: 32px
    height: 66px
    typography: 14px / 500
    states: hover and pressed observed on the shell; input remains transparent
    use: Current public marketplace search shell
  help-list-row:
    type: listItem
    backgroundColor: transparent
    textColor: '#222222'
    border: '0 0 1px #dddddd'
    rounded: 0px
    padding: 24px 0
    typography: 14px / 400 / 20.02px
    use: Current official Help article list row
fonts:
  roles:
    ui: Airbnb Cereal VF
    editorial: Cereal
---

# Airbnb

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Airbnb; reproduced for educational reference. Full prose: https://oh-my-design.kr/airbnb/design.md
