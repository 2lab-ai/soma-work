---
name: Lovable
colors:
  ink: '#030303'
  canvas: '#fafafa'
  border: '#eceae4'
  overlay-border: '#e7e7e6'
typography:
  display:
    fontSize: 60px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-1.5px'
    use: Current public display heading
  section:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-1.2px'
    use: Repeated public section heading
  heading:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.9px'
    use: Current public feature heading
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Public body and list copy
  navigation:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    use: Top-level public navigation trigger
  action:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Current compact public action
rounded:
  nav-trigger: 0px
  control: 8px
  option: 6px
  overlay: 12px
  full: 9999px
spacing:
  xxs: 4
  xs: 6
  sm: 8
  md: 10
  lg: 12
  xl: 16
  xxl: 24
  3xl: 32
components:
  header-nav-trigger:
    type: button
    backgroundColor: transparent
    textColor: '#030303'
    rounded: 0px
    padding: 4px 0px 4px 6px
    height: 32px
    typography: 15px / 400 / 24px
    states: hover, pressed, and focus captured on home::[data-omd-capture="1"]
    use: Top-level public navigation menu trigger
    hover: oklab(0.0983389 0.00000446842 0.00000196737 / 0.998508)
    pressed: oklab(0.100978 0.00000458921 0.00000201977 / 0.993438)
    focus: oklab(0.0980805 0.00000445659 0.00000196224 / 0.999007)
  header-primary-action:
    type: button
    backgroundColor: lab(0 0 0 / 0.88)
    textColor: lab(98.2716 0 0)
    rounded: 8px
    padding: 6px 10px
    height: 32px
    typography: 14px / 400 / 21px
    states: default captured on all three public routes; no role-specific hover, pressed, or focus variant promoted
    use: Current header primary action
  pricing-cycle-tab:
    type: tab
    backgroundColor: transparent
    textColor: lab(42.0087 -0.102207 0.363302)
    rounded: 9999px
    padding: 0px 12px
    height: 32px
    typography: 14px / 400 / 21px
    states: hover, pressed, and selected captured on pricing::[data-omd-capture="9"]
    use: Pricing-cycle tab on the public pricing route
  pricing-selector:
    type: button
    backgroundColor: lab(100 0 0 / 0.8)
    textColor: lab(0.903296 0 0)
    border: lab(0.903296 0 0)
    rounded: 8px
    height: 32px
    typography: 14px / 400 / 21px
    states: pressed, focus, and menu-open captured on pricing::[data-omd-capture="12"]
    use: Public pricing combobox trigger
  pricing-info-dialog:
    type: dialog
    backgroundColor: lab(99.9884 -0.0000298023 0)
    textColor: lab(0.903296 0 0)
    rounded: 12px
    padding: 16px
    typography: 16px / 400 / 24px
    shadow: rgb(255, 255, 255) 0px 0px 0px 1px, lab(98.2716 0 0) 0px 0px 0px 1px, rgba(119, 119, 113, 0.16) 0px 0px 0px 2px, rgba(0, 0, 0, 0.04) 0px 2px 1px 0px, rgba(0, 0, 0, 0.04) 0px 2px 1px -0.5px, rgba(0, 0, 0, 0.04) 0px 4px 3px -1.5px, rgba(0, 0, 0, 0.04) 0px 7px 6px -3px, rgba(0, 0, 0, 0.04) 0px 13px 12px -6px, rgba(0, 0, 0, 0.04) 0px 25px 24px -12px
    states: dialog-open captured on pricing::[data-omd-interaction-capture="dialog-3-0"]
    use: Public pricing information dialog
fonts:
  roles:
    ui: Camera Plain Variable
---

# Lovable

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Lovable; reproduced for educational reference. Full prose: https://oh-my-design.kr/lovable/design.md
