---
name: N26
colors:
  primary: '#088177'
  primary-strong: '#045e58'
  primary-deep: '#005451'
  primary-heavy: '#003b39'
  primary-light: '#a8ded8'
  primary-bright: '#d8edeb'
  primary-mist: '#809d9c'
  rhubarb: '#b55b64'
  rhubarb-strong: '#b04364'
  rhubarb-deep: '#8e1b44'
  rhubarb-light: '#ffdce1'
  lagoon: '#1d6ea2'
  lagoon-deep: '#00395f'
  lagoon-light: '#c6eaff'
  sand: '#c6b29f'
  cream: '#faf8f5'
  cream-deep: '#ede7e0'
  foreground: '#1b1b1b'
  gray-strong: '#6d6d6d'
  gray-deep: '#2a2a2a'
  gray-line: '#d9d9d9'
  canvas: '#ffffff'
typography:
  body:
    fontSize: 16px
    use: N26 400/500; the buttons at 500
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 16px
  pill: 24px
  xl: 32px
  xxl: 40px
components:
  button-primary:
    type: button
    backgroundColor: '#003b39'
    textColor: '#ffffff'
    rounded: 24px
    height: 48px
    padding: 12px 24px
    typography: 16px / 500
    hover: '#045e58'
    focus: 'ring 0 0 0 2px #ffffff, 0 0 0 4px #045e58'
    use: Girokonto eröffnen — the account-opening pill in --color-nemoTealHeavy. Hover lightens to --color-nemoTealStrong over 0.15s; focus draws a double ring, 2px white inside 4px teal.
    pressed: 'bg #045e58 (:hover + :active)'
  button-tonal:
    type: button
    backgroundColor: rgba(198,178,159,0.25)
    textColor: '#003b39'
    rounded: 24px
    height: 48px
    padding: 12px 24px
    typography: 16px / 500
    hover: rgba(198,178,159,0.5)
    focus: 'ring 0 0 0 2px #ffffff, 0 0 0 4px #045e58'
    use: Login in the header — sand at 25% (--color-nemoSand25) with a deep-teal label. Hover doubles the sand to 50%; focus is the same double ring.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: N26
    display: N26-Extended
---

# N26

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to N26; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/n26/DESIGN.md
