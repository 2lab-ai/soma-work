---
name: Lamborghini
colors:
  primary: '#ffc000'
  primary-muted: '#917300'
  surface-light: '#ffffff'
  foreground: '#202020'
  on-primary: '#000000'
  inverse: '#ffffff'
  muted: '#969696'
rounded:
  square: 0px
spacing:
  xs: 8
  sm: 16
  md: 24
  lg: 32
  section: 48
components:
  accent-cta:
    type: button
    backgroundColor: '#ffc000'
    textColor: '#000000'
    rounded: 0px
    padding: 24px
    typography: 16px / 400 / LamboType
    states: captured in selected/tab-selected surface context; no activation transition asserted
    use: Marketing accent action at home::[data-omd-capture="45"]
    height: 72px
    pressed: 'bg #997300 (:hover + :active)'
    focus: 'outline #1e90ff solid 2px on :focus-visible'
  outline-action:
    type: button
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 0px
    padding: 24px
    typography: 16px / 400 / LamboType
    states: captured in selected/tab-selected surface context; no activation transition asserted
    use: Marketing secondary action at home::[data-omd-capture="46"]
  menu-link:
    type: button
    textColor: '#ffffff'
    rounded: 0px
    padding: 16px 0px
    typography: 18px / 400 / LamboType
    states: default capture; menu open/close transition was not captured
    use: Burger-menu hierarchy link at home::[data-omd-capture="4"]
  selected-tab:
    type: tab
    textColor: '#ffffff'
    border: '0px 0px 2px #ffc000'
    rounded: 0px
    padding: 24px
    typography: 16px / 400 / LamboType
    states: selected and tab-selected after observed tab interaction
    use: React tab at home::[data-omd-capture="41"]
  news-card:
    type: card
    textColor: '#202020'
    rounded: 0px
    padding: 0px
    use: News-card image wrapper at home::div.card-news__image-wrapper
omitted:
  - section: typography
    reason: No verified values in current evidence.
fonts:
  roles:
    ui: LamboType
---

# Lamborghini

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Lamborghini; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/lamborghini/DESIGN.md
