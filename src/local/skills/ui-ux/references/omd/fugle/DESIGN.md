---
name: Fugle
colors:
  primary: '#f4af1c'
  primary-hover: '#e49b00'
  primary-tint: '#fef4cf'
  secondary: '#4c85a0'
  secondary-hover: '#36708c'
  canvas: '#ffffff'
  bg-secondary: '#f5f5f5'
  border: '#eaeaea'
  border-heavy: '#dfdfdf'
  text: '#323232'
  text-muted: '#8b8a8a'
  dark-surface: '#131313'
  rise: '#f3746d'
  fall: '#6c9c46'
  error: '#d12a2a'
typography:
  highlight:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Data highlight values
  heading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: Dialog / section headings
  modal:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Modal body, form inputs
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Dense data rows
  label:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Secondary labels, timestamps
rounded:
  sm: 4px
  md: 4px
  lg: 8px
  full: 9999px
spacing:
  xs: 5
  sm: 8
  base: 16
  lg: 20
  xl: 32
  section: 50
components:
  button-primary:
    type: button
    backgroundColor: '#f4af1c'
    textColor: '#ffffff'
    rounded: 4px
    typography: 14px / 700
    use: 'Amber CTA; hover #e49b00'
  input-default:
    type: input
    backgroundColor: '#eaeaea'
    rounded: 4px
    padding: 0 5px
    typography: 16px / 400
    use: Search / trade input, 32px height
  list-item-stock:
    type: listItem
    backgroundColor: '#ffffff'
    rounded: 0px
    typography: 14px / 400
    use: 'Watchlist row, 55px height, 1px #eaeaea border; hover rgba(0,0,0,0.04)'
  card-trade:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 20px 0
    use: Surface trade box card
  card-info:
    type: card
    backgroundColor: '#eaeaea'
    rounded: 8px
    use: Highlighted info box
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 16px
    typography: 16px / 400
    use: Modal dialog container
fonts:
  roles:
    sans: Lato
    mono: Lato
---

# Fugle

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Fugle; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/fugle/DESIGN.md
