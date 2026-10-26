---
name: Resend
colors:
  primary: '#00a3ff'
  canvas: '#000000'
  foreground: '#f0f0f0'
  muted: '#a1a4a5'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 96px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.96px'
    use: Marketing h1
  section-heading:
    fontSize: 56px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: '-2.8px'
    use: Marketing h2
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Marketing body and lists
  control:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Observed Inter controls
rounded:
  control: 4px
  menu: 12px
  panel: 16px
  full: 9999px
spacing:
  unit: 4
  control-x: 12
  control-y: 5
  menu-x: 24
  menu-y: 8
components:
  primary-cta:
    type: button
    backgroundColor: '#00a3ff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 20px
    typography: 14px / 600 / Helvetica (system-computed)
    states: default capture only
    use: Home marketing primary CTA
    height: 41px
  outline-pill:
    type: button
    textColor: '#f0f0f0'
    border: 1px solid rgba(214,235,253,0.19)
    rounded: 9999px
    padding: 5px 12px
    typography: 14px / 400 / Inter
    states: default capture only
    use: Home marketing outline control
  header-control:
    type: button
    textColor: '#a1a4a5'
    padding: 4px 12px
    typography: 14px / 500 / Inter
    states: default capture only
    use: Home header navigation control
  selected-tab-panel:
    type: tab
    backgroundColor: rgba(214,235,253,0.19)
    textColor: '#f0f0f0'
    rounded: 16px
    states: selected tab capture
    use: Home selected tab panel
  menu-option:
    type: listItem
    textColor: rgba(233,240,253,0.525)
    rounded: 12px
    padding: 8px 24px
    states: menu-open selected capture
    use: Audiences feature-page menu option
  disabled-action:
    type: button
    textColor: '#4a4a4a'
    rounded: 12px
    padding: 12px
    states: disabled capture
    use: Automations feature-page disabled action
fonts:
  roles:
    ui: Inter
    display: ABC Favorit
    editorial: Domaine Display
---

# Resend

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Resend; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/resend/DESIGN.md
