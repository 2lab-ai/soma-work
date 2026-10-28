---
name: Trainline
colors:
  primary: '#00a88f'
  primary-dark: '#007f6c'
  action: '#2332c4'
  action-dark: '#0035a9'
  ink: '#192325'
  body: '#3f4b4e'
  muted: '#5b6466'
  canvas: '#ffffff'
  surface: '#f2f4f4'
  surface-alt: '#ebf2ff'
  sign-in-bg: '#e7ebeb'
  hairline: '#d0d4d5'
  warning-bg: '#fdf7c9'
  warning-text: '#502e00'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.71
    use: Hero headline — 'Buy train tickets for travel in the UK and Europe'
  section:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    use: Section heads, TLCircular — 'Save 1/3 with a Season Ticket'
  subsection:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: Feature card heads, TLCircular — 'Spend less, travel more'
  nav:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.71
    use: Nav links — 'Railcards', 'Business'
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.71
    use: Standard reading text, system font stack
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    use: CTA labels
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  pill: 26px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#00a88f'
    textColor: '#ffffff'
    rounded: 4px
    padding: 10px 12px
    height: 48px
    typography: 16px / 600 TLCircular
    use: Primary booking CTA — 'Find cheap tickets'
  button-action:
    type: button
    backgroundColor: '#2332c4'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 16px
    height: 40px
    typography: 14px / 400 system-ui
    use: Search/change action button on results surface
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#192325'
    border: '1px solid #d0d4d5'
    rounded: 4px
    padding: 8px 16px
    height: 40px
    typography: 16px / 700 system-ui
    use: Secondary white outlined CTAs — 'Buy now', 'Buy your Railcard'
  button-sign-in:
    type: button
    backgroundColor: '#e7ebeb'
    textColor: '#192325'
    rounded: 26px
    padding: 2px 8px 2px 16px
    height: 40px
    typography: 16px / 600 system-ui
    use: Sign-in pill button in nav
  input-station:
    type: input
    backgroundColor: '#f2f4f4'
    textColor: '#000000'
    border: 2px solid transparent
    rounded: 4px
    padding: 16px 16px 16px 96px
    height: 56px
    typography: 16px / 400 system-ui
    use: Station autocomplete inputs — departure and arrival
  input-date:
    type: input
    backgroundColor: '#f2f4f4'
    textColor: '#000000'
    rounded: 4px
    padding: 16px
    height: 56px
    typography: 16px / 600 system-ui
    use: Date/time selector field
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    use: Feature promotional cards — Season Ticket, Railcard promotions
  badge-warning:
    type: badge
    backgroundColor: '#fdf7c9'
    textColor: '#502e00'
    rounded: 0px
    use: Service disruption banner at top of page
  tab-nav:
    type: tab
    textColor: '#192325'
    typography: 14px / 600 system-ui
    use: Top nav items
    active: 'text #192325 highlighted'
fonts:
  roles:
    display: TLCircular
    body: '-apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
---

# Trainline

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Trainline; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/trainline/DESIGN.md
