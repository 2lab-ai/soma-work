---
name: Plaid
colors:
  primary: '#02294b'
  navy-deep: '#00172e'
  indigo-deep: '#0d0d3f'
  ink-teal: '#012e37'
  ink: '#111111'
  ink-button: '#111112'
  charcoal: '#232424'
  blue: '#043c67'
  link: '#0a54c4'
  slate: '#5c7695'
  green: '#468254'
  canvas: '#ffffff'
  surface: '#f7faff'
  surface-grey: '#f6f6f6'
  hairline: '#ebf0f4'
  hairline-alt: '#dde3e9'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 76px
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: '-3.4px'
    use: Home hero H1, Plaid Sans, gradient text fill
  display-dark:
    fontSize: 70px
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: '-2.8px'
    use: Dark-section H2 headlines, Plaid Sans
  section:
    fontSize: 60px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-2px'
    use: Product section H2, Plaid Sans
  page-title:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-2px'
    use: Products page H1, Plaid Sans
  subhead:
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: '-0.5px'
    use: Feature H3 subheads, slate, Plaid Sans
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    use: Product card H3, Plaid Sans
  stat:
    fontSize: 36px
    fontWeight: 800
    lineHeight: 1.33
    use: Stat figures, Cern
  eyebrow:
    fontSize: 16px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: 2px
    use: All-caps eyebrow label, Plaid Sans
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, Cern
  button:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1
    use: Hero pill CTA label, Plaid Sans
  button-sm:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    use: Header pill CTA label, Plaid Sans
rounded:
  sm: 6px
  md: 8px
  lg: 12px
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
  button-primary-dark:
    type: button
    backgroundColor: '#02294b'
    textColor: '#ffffff'
    rounded: 100px
    padding: 0 24px
    height: 56px
    typography: 20px / 600 Plaid Sans
    use: Hero pill CTA on dark/navy sections — Start building, Read the docs
  button-primary-light:
    type: button
    backgroundColor: '#111112'
    textColor: '#ffffff'
    rounded: 100px
    padding: 0 18px
    height: 39px
    typography: 16px / 600 Plaid Sans
    use: Header dark pill CTA — Contact sales
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#232424'
    border: '1px solid #dde3e9'
    rounded: 9999px
    padding: 12px 24px
    height: 47px
    typography: 14px / 600 Plaid Sans
    use: Secondary outline pill — See all products
  button-ghost:
    type: button
    textColor: '#111112'
    rounded: 100px
    typography: 16px / 600 Plaid Sans
    use: Quiet header pill — Log in
  nav-link:
    type: tab
    textColor: '#232424'
    rounded: 9999px
    padding: 12px 16px
    typography: 16px / 400 Plaid Sans
    active: 'text #012e37'
    use: Top nav pill items
  menu-item:
    type: listItem
    backgroundColor: '#f7faff'
    textColor: '#012e37'
    rounded: 6px
    padding: 13px 16px
    typography: 16px / 400 Plaid Sans
    use: Mega-menu dropdown row
  card-product:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#00172e'
    border: '1px solid #ebf0f4'
    rounded: 12px
    use: White product card, hairline border, no shadow
  card-dark:
    type: card
    backgroundColor: '#02294b'
    textColor: '#ffffff'
    rounded: 12px
    use: Dark-navy feature/section card
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#4b4b4b'
    border: '1px solid #02294b'
    rounded: 8px
    padding: 8px 8px 8px 16px
    typography: 16.5px Cern
    use: Form text input, navy hairline border
  badge-eyebrow:
    type: badge
    textColor: '#00172e'
    typography: 16px / 800 Plaid Sans
    use: All-caps eyebrow label, 2px tracking
fonts:
  roles:
    display: Plaid Sans
    body: Cern
---

# Plaid

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Plaid; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/plaid/DESIGN.md
