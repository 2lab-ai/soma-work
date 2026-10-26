---
name: ServiceNow Horizon
colors:
  navy: '#102c40'
  canvas: '#ffffff'
  ink: '#222222'
  content-ink: '#0b1012'
  border-subtle: '#cfd5d7'
  link-teal: '#00718f'
typography:
  display:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 72
    letterSpacing: '-2.56px'
    use: Observed Horizon home H1
  section-title:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 52
    letterSpacing: '-0.8px'
    use: Observed About Horizon section heading
  body:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 27.424
    use: Observed Horizon about-page list and body sample
rounded:
  square: 0px
  card: 8px
  control: 8px
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 32
components:
  workspace-page-link:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#0000ee'
    rounded: 8px
    height: 298px
    typography: 16px / 400 ServiceNowSans
    use: Workspace components page-card link, selector surface-3::[data-omd-capture=93]
  primary-action:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    border: 1px solid transparent
    rounded: 8px
    padding: 8px 20px
    height: 42px
    typography: 14px / 450 ServiceNowSans
    states: default only; no interaction state captured
    use: Horizon home primary action, selector home::[data-omd-capture=15]
  nav-trigger:
    type: button
    textColor: '#222222'
    rounded: 0px
    padding: 24px 8px
    height: 64px
    typography: 16px / 300 ServiceNowSansLight
    states: default only; no interaction state captured
    use: Horizon global-nav trigger with button role, selector home::[data-omd-capture=1]
fonts:
  roles:
    ui: ServiceNowSans
---

# ServiceNow Horizon

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ServiceNow Horizon; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/servicenow/DESIGN.md
