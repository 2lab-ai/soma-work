---
name: Zapier
colors:
  primary: '#ff4f00'
  canvas: '#fffefb'
  ink: '#201515'
  body: '#605d52'
  ink-muted: '#36342e'
  surface-soft: '#f8f4f0'
  divider: '#eceae3'
  sand: '#c5c0b1'
  on-primary: '#fffefb'
typography:
  display:
    fontSize: 56px
    fontWeight: 500
    lineHeight: 1
    use: Observed public-marketing h1
  heading:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1
    use: Observed public-marketing h2
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Repeated public-marketing body and list content
  action:
    fontSize: 18px
    fontWeight: 600
    use: 48px public marketing actions
  code-control:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed code-copy control only
rounded:
  icon: 2px
  control: 4px
  card: 8px
  header-pill: 18px
spacing:
  xs: 4
  sm: 6
  md: 8
  control: 10
  lg: 12
  xl: 16
  xxl: 24
  section: 32
components:
  marketing-primary-action:
    type: button
    backgroundColor: '#ff4f00'
    textColor: '#fffefb'
    border: '1px solid #ff4f00'
    rounded: 4px
    padding: 12px 24px
    height: 48px
    typography: 18px / 600 / Inter
    states: focus, hover, and pressed observed
    use: Public home and customer-support marketing action; representative home::[data-omd-capture="25"]
    pressed: 'bg #d24304, border #d24304 (+2 nested-layer changes) (:hover + :active)'
    focus: 'outline #201515 solid 2px (+2 nested-layer changes) on :focus-visible'
  marketing-dark-action:
    type: button
    backgroundColor: '#201515'
    textColor: '#fffefb'
    border: '1px solid #201515'
    rounded: 4px
    padding: 12px 24px
    height: 48px
    typography: 18px / 600 / Inter
    states: focus, hover, pressed, selected, and tab-selected observed
    use: Public marketing action across all supplied surfaces; representative home::[data-omd-capture="22"]
  header-sign-up:
    type: button
    backgroundColor: '#ff4f00'
    textColor: '#fffefb'
    border: '1px solid #ff4f00'
    rounded: 18px
    padding: 6px 12px
    height: 36px
    typography: 14px / 600 / Inter
    states: focus, hover, and pressed observed
    use: Compact public header sign-up action across supplied surfaces; representative home::[data-omd-capture="10"]
    hover: '#fe4f00'
    pressed: '#fd4e00'
    focus: '#fd4f00'
  product-gallery-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#201515'
    border: 0px
    rounded: 0px
    padding: 10px 16px
    typography: 14px / 600 / Inter
    states: selected and tab-selected observed
    use: Selected public home gallery tab; representative home::[data-omd-capture="26"]
  pricing-menu-option:
    type: tab
    backgroundColor: transparent
    textColor: '#36342e'
    rounded: 4px
    padding: 8px 12px
    typography: 16px / 400 / Inter
    states: expanded and menu-open observed
    use: Pricing menu option after the captured menu interaction; representative surface-2::[data-omd-interaction-capture="menu-0-1"]
fonts:
  roles:
    ui: Inter
    display: Degular Display
    mono: JetBrains Mono
---

# Zapier

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Zapier; reproduced for educational reference. Full prose: https://oh-my-design.kr/zapier/design.md
