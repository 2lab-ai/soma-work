---
name: Doctolib
colors:
  brand: '#045fae'
  primary: '#00264c'
  foreground: '#00264c'
  text-secondary: '#294056'
  neutral: '#3a5978'
  mute: '#7599bd'
  brand-chrome: '#107aca'
  brand-subtle: '#d0e9fb'
  brand-subtle-weak: '#e7f4fd'
  surface-subtle: '#f1f7fe'
  border-subtle: '#c9d9e8'
  canvas: '#ffffff'
  danger: '#e5004c'
  positive: '#00806a'
  warning: '#aa6709'
  informative: '#007ab3'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    use: the search fields and the search button, Roboto
rounded:
  sm: 8px
  md: 12px
  search: 32px
  pill: 999px
components:
  button-search:
    type: button
    backgroundColor: '#00264c'
    textColor: '#ffffff'
    border: '#ffffff'
    rounded: 0 32px 32px 0
    height: 60px
    padding: 16px
    typography: 14px / 400
    hover: '#00264c'
    pressed: '#00264c'
    focus: 'box-shadow 0 0 0 2px #ffffff, 0 0 0 4px #3a5978'
    use: Rechercher, the right end of the home-page search pill. Hover and press change nothing (confirmed with :hover and :active matched); focus draws a white ring inside a slate one — --oxygen-color-semantic-neutral-prominent-base.
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#294056'
    border: '#294056'
    rounded: 32px 0 0 32px
    height: 60px
    padding: 0 16px 0 46px
    typography: 14px / 400
    hover: '#ffffff'
    focus: '#ffffff'
    use: The practitioner field (Nom, spécialité, établissement…), the left end of the search pill with an icon slot. Hover and focus change nothing, and no focus indicator is drawn.
  input-location:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#294056'
    border: '#294056'
    rounded: 0px
    height: 60px
    padding: 0 46px
    typography: 14px / 400
    hover: '#ffffff'
    focus: '#ffffff'
    use: The location field (Où ?), the square middle of the search pill. Like the practitioner field, it shows no hover or focus change.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Montserrat
    sans: Roboto
---

# Doctolib

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Doctolib; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/doctolib/DESIGN.md
