---
name: Together AI
colors:
  primary: '#000000'
  canvas: '#ffffff'
  tab-cyan: '#c8f6f9'
  tab-lavender: '#e2e1fe'
typography:
  display:
    fontSize: 64px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: '-1.92px'
    use: Observed marketing h1
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.25
    use: Observed public marketing, about, and brand body/list text
  action:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.08px
    use: Observed compact public action
  label:
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.055px
    use: Observed public mono label
rounded:
  none: 0px
  control: 4px
  container: 8px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 16
  xl: 20
  xxl: 40
components:
  primary-action:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 16px
    height: 40px
    typography: 16px / 500 PP Neue Montreal Mono
    states: hover, focus, and pressed captured for selector; no common state value promoted
    use: Public compact action at home::[data-omd-capture=20]
    hover: rgba(0, 0, 0, 0.984)
    pressed: rgba(0, 0, 0, 0.97)
    focus: rgba(0, 0, 0, 0.992)
  secondary-action:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.08)
    textColor: '#000000'
    rounded: 4px
    padding: 16px
    typography: 16px / 500 PP Neue Montreal Mono
    states: hover, focus, and pressed captured for selector
    use: Public light-surface action at home::[data-omd-capture=22]
    hover: rgba(0, 0, 0, 0.082)
    pressed: rgba(0, 0, 0, 0.082)
    focus: rgba(0, 0, 0, 0.082)
  selected-tab-cyan:
    type: tab
    backgroundColor: '#c8f6f9'
    textColor: '#000000'
    rounded: 4px
    padding: 4px 0px
    height: 72px
    typography: 16px / 400 The Future
    states: selected and tab-selected observed
    use: Home tab at home::[data-omd-capture=29]
  tab-panel:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 8px
    padding: 16px 16px 16px 40px
    use: Home tab panel at home::#tabs-0-panel-0 (role tabpanel)
  research-card:
    type: card
    backgroundColor: rgba(255, 255, 255, 0.08)
    textColor: '#ffffff'
    rounded: 4px
    padding: 20px 40px
    use: Home research card at home::div.research-card
  disabled-slider-arrow:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.12)
    textColor: '#ffffff'
    rounded: 4px
    size: 40px
    states: disabled observed
    use: Disabled home carousel arrow at home::[data-omd-capture=38]
fonts:
  roles:
    ui: The Future
    label: PP Neue Montreal Mono
---

# Together AI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Together AI; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/together.ai/DESIGN.md
