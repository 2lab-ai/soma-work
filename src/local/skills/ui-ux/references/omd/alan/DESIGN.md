---
name: Alan
colors:
  primary: '#5c59f3'
  primary-hover: '#2f33a8'
  primary-pressed: '#0c0a66'
  indigo-100: '#d6dbff'
  indigo-50: '#f0f3ff'
  heading: '#282830'
  foreground: '#464754'
  caption: '#656779'
  grey-500: '#9da3ba'
  border: '#ecf1fc'
  surface: '#f5f8fe'
  canvas: '#ffffff'
  cream: '#fffcf5'
  fluo-yellow: '#fcff7e'
  teal: '#2aa79c'
  teal-dark: '#124548'
  orange: '#ff9359'
  danger: '#ed4e4e'
  success: '#7fca6c'
typography:
  button:
    fontSize: 16px
    fontWeight: 500
    use: hero buttons
  nav:
    fontSize: 13.33px
    fontWeight: 400
    use: segment navigation
rounded:
  md: 12px
  lg: 16px
components:
  button-primary:
    type: button
    backgroundColor: '#5c59f3'
    textColor: '#ffffff'
    rounded: 16px
    height: 48px
    typography: 16px / 500
    shadow: rgba(40,40,48,0.06) 0 1px 4px
    hover: '#2f33a8'
    pressed: '#0c0a66'
    use: Mon devis en 2 min in the hero — --c-indigo500, darkening to --c-indigo700 on hover and --c-indigo900 on press. Focus is the browser's ring.
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5c59f3'
    border: '#ecf1fc'
    rounded: 16px
    height: 48px
    typography: 16px / 500
    shadow: rgba(40,40,48,0.06) 0 1px 4px
    pressed: 'border #f5f8fe'
    use: Demander une démo beside it — white with an indigo label and a --c-grey100 border; hover changes nothing, press lightens the border to --c-grey50.
  nav-segment:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 16px
    height: 40px
    typography: 13.33px / 400
    hover: '#f5f8fe'
    pressed: '#f5f8fe'
    use: Entreprises, Indépendants, Particuliers — the audience switch in the header; hover and press fill it with --c-grey50.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Alan Sans
---

# Alan

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Alan; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/alan/DESIGN.md
