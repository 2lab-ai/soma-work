---
name: Fever
colors:
  primary: '#0079ca'
  primary-hover: '#0068b0'
  primary-weak: '#e6f4ff'
  focus-glow: '#add4ee'
  ink: '#031419'
  black: '#000405'
  main-contrast: '#06232c'
  subtle-contrast: '#2c4751'
  text-secondary: '#536b75'
  text-disabled: '#a7b2ba'
  canvas: '#ffffff'
  surface: '#fafbfb'
  surface-subtle: '#f2f3f3'
  border: '#ccd2d8'
  accent: '#6f41d7'
  accent-weak: '#f0ebfd'
  danger: '#eb0052'
  success: '#18824c'
  warning: '#9f5800'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: body, links and the city search
  chip:
    fontSize: 14px
    fontWeight: 600
    use: category filter chips
rounded:
  chip: 64px
  search: 32px
  button: 100px
components:
  chip-selected:
    type: button
    backgroundColor: '#000405'
    textColor: '#fafbfb'
    rounded: 64px
    height: 38px
    padding: 8px 16px
    typography: 14px / 600
    hover: '#000405'
    pressed: '#000405'
    focus: 'outline 2px solid #000405'
    use: 'All — the selected category chip on a city page: near-black with an off-white label; hover changes nothing; focus a 2px outline.'
  chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#031419'
    border: '#a7b2ba'
    rounded: 64px
    height: 38px
    padding: 8px 16px
    typography: 14px / 600
    hover: '#fafbfb'
    pressed: '#fafbfb'
    focus: 'outline 2px solid #000405'
    use: 'Live Music, Nightlife, Family … — white chips with a grey border that tint #fafbfb on hover.'
  link-see-all:
    type: button
    backgroundColor: transparent
    textColor: '#031419'
    rounded: 0px
    height: 24px
    typography: 16px / 400
    hover: 'fg #536b75'
    pressed: 'fg #536b75'
    use: 'See all — ink text that turns #536b75 and underlines on hover and press.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Montserrat
---

# Fever

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Fever; reproduced for educational reference. Full prose: https://oh-my-design.kr/fever/design.md
