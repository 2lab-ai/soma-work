---
name: Expo
colors:
  primary: '#000000'
  canvas: '#f0f0f3'
  surface: '#ffffff'
  foreground: '#1c2024'
  muted: '#60646c'
  subtle: '#80838d'
  on-primary: '#ffffff'
  hairline: '#e0e1e6'
  control-border: '#d9d9e0'
  link: '#0d74ce'
typography:
  hero:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-3px'
    use: Current marketing hero heading
  section:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-2px'
    use: Repeated marketing section heading
  subheading:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.5px'
    use: Marketing subheading
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Repeated marketing body and list text
  action:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    use: Compact action label
  code:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.6
    use: Observed code-oriented marketing text
rounded:
  dialog: 8px
  action: 36px
  hero-action: 48px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 24
  xxl: 32
components:
  header-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 36px
    padding: 0 16px
    height: 36px
    typography: 14px / 500 / Inter
    states: 'hover and pressed observed; pressed background #010101'
    use: Repeated header conversion action across the three marketing surfaces
    pressed: '#010101'
  pricing-action:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 32px
    padding: 0 12px
    height: 32px
    typography: 12px / 500 / Inter
    states: 'hover background #010101 and pressed background #030304 observed'
    use: Pricing-surface compact action that opens a dialog
    hover: '#010101'
    pressed: '#030304'
  pricing-dialog:
    type: dialog
    rounded: 8px
    shadow: rgba(0,0,0,0.1) 0px 10px 20px, rgba(0,0,0,0.05) 0px 3px 6px
    typography: 16px / 400 / Inter
    states: dialog-open observed
    use: Observed pricing dialog panel; fill was not promoted because the captured panel is transparent
fonts:
  roles:
    ui: Inter
    mono: JetBrains Mono
---

# Expo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Expo; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/expo/DESIGN.md
