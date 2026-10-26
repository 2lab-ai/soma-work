---
name: U.S. Web Design System
colors:
  primary: '#005ea2'
  primary-vivid: '#0050d8'
  canvas: '#fcfcfc'
  foreground: '#1b1b1b'
  hairline: '#e6e6e6'
  header: '#252f3e'
  search-surface: '#13171f'
  search-action: '#2672de'
  inverse: '#ffffff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: Observed documentation body baseline
  form-input:
    fontSize: 16.96px
    fontWeight: 400
    lineHeight: 1.3
    use: Observed text input baseline
rounded:
  none: 0px
  control: 4px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 24
components:
  search-submit:
    type: button
    backgroundColor: '#2672de'
    textColor: '#ffffff'
    border: 0px
    rounded: 0px 4px 4px 0px
    padding: 0px 12px
    size: 48px x 38px
    typography: 16.96px / 700 / Source Sans Pro Web
    states: Default baseline observed; no hover, focus, pressed, disabled, or error value was captured.
    use: Observed site-search submit control on all three captured surfaces
    height: 38px
    pressed: 'bg #0050d8, outline #2491ff solid 4px (:hover + :active)'
    focus: 'outline #2491ff solid 4px on :focus-visible'
  side-navigation-item:
    type: listItem
    backgroundColor: transparent
    textColor: '#000000'
    border: 0px
    rounded: 0px
    size: 204px x 38px
    typography: 15.04px / 400 / Public Sans Web
    use: Observed side-navigation row on the official components overview and accordion documentation surfaces
fonts:
  roles:
    ui: Public Sans Web
    form: Source Sans Pro Web
---

# U.S. Web Design System

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to U.S. Web Design System; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/uswds/DESIGN.md
