---
name: Oura
colors:
  primary: '#2a72de'
  primary-hover: '#2056a6'
  focus: '#3184ff'
  foreground: '#000000'
  sandstone-ink: '#4a4741'
  cream: '#f7f1e8'
  cream-100: '#eee6dc'
  sandstone-100: '#fefaef'
  sandstone-450: '#e6ded3'
  canvas: '#ffffff'
  gray-450: '#5a5958'
  gray-350: '#a8a5a0'
  border: '#ececec'
  slate: '#27455c'
  slate-500: '#1b3449'
  mustard: '#af751b'
  olive: '#5c6f5d'
  brown: '#715956'
  red: '#d22c15'
typography:
  button:
    fontSize: 16px
    fontWeight: 700
    use: the blue call to action
  nav:
    fontSize: 16px
    fontWeight: 400
    use: header controls
rounded:
  pill: 9999px
components:
  button-primary:
    type: button
    backgroundColor: '#2a72de'
    textColor: '#ffffff'
    border: '#ececec'
    rounded: 9999px
    height: 48px
    typography: 16px / 700
    hover: '#2056a6'
    pressed: '#2056a6'
    focus: 'outline 2px solid #3184ff'
    use: 'Mehr erfahren — a blue pill (--color-blue-100 #2a72de) darkening to --color-blue-200 #2056a6 on hover and press; focus is a 2px bright-blue outline.'
    padding: 12px 24px
  nav-pill:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '#000000'
    rounded: 9999px
    height: 48px
    typography: 16px / 400
    hover: transparent
    focus: 'outline 2px solid #3184ff'
    use: Gesundheit, Jetzt kaufen and the other header pills — no change on hover (pseudo-elements included); focus draws the same 2px outline.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Editorial New
    sans: Akkurat LL
---

# Oura

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Oura; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/oura/DESIGN.md
