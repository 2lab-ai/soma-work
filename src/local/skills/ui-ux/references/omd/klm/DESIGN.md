---
name: KLM
colors:
  primary: '#0070c2'
  primary-hover: '#005496'
  primary-pressed: '#003d6d'
  foreground: '#002746'
  navy-900: '#001527'
  background: '#f6f7f8'
  canvas: '#ffffff'
  tertiary-hover: '#eaebec'
  tertiary-pressed: '#d4d8da'
  primary-50: '#eaf4fb'
  blue-200: '#a5d5ef'
  signature: '#009fda'
  text-muted: '#536069'
  text-disabled: '#889096'
  border-strong: '#aab0b5'
  flying-blue: '#0800b9'
  critical: '#ad0029'
  la-premiere: '#d40504'
typography:
  button:
    fontSize: 14px
    fontWeight: 500
    use: flight search button
  nav:
    fontSize: 16px
    fontWeight: 400
    use: header tabs
rounded:
  sm: 4px
components:
  button-search:
    type: button
    backgroundColor: '#0070c2'
    textColor: '#ffffff'
    rounded: 4px
    height: 48px
    typography: 14px / 500
    hover: '#005496'
    pressed: '#003d6d'
    use: 'Zoek vluchten — --aero-color-background-brand, stepping to --aero-color-surface-action-primary-hover #005496 and #003d6d when pressed.'
  nav-tab:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0070c2'
    border: '#0070c2'
    rounded: 4px
    height: 50px
    typography: 16px / 400
    hover: '#eaebec + fg #005496'
    pressed: '#d4d8da + fg #003d6d'
    focus: 'outline 2px solid #001527'
    use: Boeken, Mijn Reis, Check-in, Flying Blue — white tabs whose grey wash and blue label deepen on hover and press; focus is a 2px navy outline.
  button-utility:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#002746'
    border: '#002746'
    rounded: 4px
    height: 48px
    padding: 12px
    typography: 20px / 500
    hover: '#eaebec'
    pressed: '#d4d8da'
    focus: 'outline 2px solid #001527'
    use: 'Zoeken, Inloggen in the header — white with navy text; --aero-color-surface-action-tertiary-hover #eaebec, then #d4d8da.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Universal Sans Display
    sans: Universal Sans Text
---

# KLM

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KLM; reproduced for educational reference. Full prose: https://oh-my-design.kr/klm/design.md
