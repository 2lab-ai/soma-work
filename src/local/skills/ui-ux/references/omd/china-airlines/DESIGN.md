---
name: 中華航空
colors:
  canvas: '#ffffff'
  ink: '#17181c'
  primary: '#23569d'
  primary-bright: '#1d6dcd'
  booking-accent: '#d81159'
  on-primary: '#ffffff'
  muted: '#69707a'
  hairline: '#8e959f'
  soft-blue: '#f1f8fd'
  soft-blue-border: '#9fd1f1'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 28
    letterSpacing: 0.16px
    use: Measured public-web body and list text; no brand family token
  action:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 28
    letterSpacing: 0.16px
    use: Measured public-web primary-action text; no brand family token
  section-heading:
    fontSize: 40px
    fontWeight: 500
    lineHeight: 56
    letterSpacing: 0px
    use: Measured public-web section heading; no brand family token
rounded:
  control: 8px
  dialog: 20px
  pill: 40px
spacing:
  action-x: 20
  menu-end: 24
  dialog-viewport: 40
components:
  action-primary-blue:
    type: button
    backgroundColor: '#23569d'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 20px
    height: 56px
    typography: 16px / 500
    states: default observed on all three captured public surfaces; no altered pseudo-state captured
    use: Primary blue public-web action; `home::[data-omd-capture="99"]`
  selected-menu-option:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#23569d'
    rounded: 8px
    padding: 0px 12px
    height: 48px
    typography: 16px / 500
    states: expanded menu and selected option state observed (`aria-selected=true`)
    use: Selected option button in the captured public booking/menu control; `home::[data-omd-capture="88"]`
  search-dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 20px
    shadow: rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(23, 24, 28, 0.12) 0px 2px 4px 0px, rgba(23, 24, 28, 0.09) 0px 4px 28px 0px, rgba(23, 24, 28, 0.04) 0px 4px 16px 0px, rgba(23, 24, 28, 0.04) 0px 60px 50px 0px, rgba(23, 24, 28, 0.1) 0px 20px 32px 0px, rgba(23, 24, 28, 0.1) 0px 0px 0px 0px
    states: default shell and dialog-open state observed
    use: Public search dialog shell; `home::div[role=dialog]`
---

# 中華航空

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 中華航空; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/china-airlines/DESIGN.md
