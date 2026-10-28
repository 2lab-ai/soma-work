---
name: Mercury
colors:
  primary: '#5266eb'
  primary-hover: '#4354c8'
  primary-active: '#3442a6'
  periwinkle: '#9cb4e8'
  mist: '#cdddff'
  canvas: '#171721'
  canvas-elevated: '#1e1e2a'
  canvas-light: '#fbfcfd'
  surface: '#ededf3'
  surface-secondary: '#f4f5f9'
  surface-hover: '#dddde5'
  ink-subdued: '#c3c3cc'
  ink-disabled: '#70707d'
  on-primary: '#ffffff'
  error: '#d03275'
  hairline: '#272735'
typography:
  display-hero:
    fontSize: 65px
    fontWeight: 360
    lineHeight: 1.05
    letterSpacing: 0.42px
    use: Marketing hero, Arcadia Display
  display-lg:
    fontSize: 48px
    fontWeight: 360
    lineHeight: 1.1
    letterSpacing: 0.42px
    use: Section openers
  heading-lg:
    fontSize: 28px
    fontWeight: 480
    lineHeight: 1.25
    use: Feature titles, modal headers
  heading:
    fontSize: 22px
    fontWeight: 480
    lineHeight: 1.3
    use: Card headings, sub-sections
  subtitle:
    fontSize: 18px
    fontWeight: 420
    lineHeight: 1.4
    use: List headers, nav titles
  body-lg:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.625
    use: Lead paragraphs
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.625
    use: Standard reading text
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Secondary info, dense tables
  caption:
    fontSize: 12px
    fontWeight: 420
    lineHeight: 1.4
    use: Metadata, timestamps, labels
rounded:
  sm: 4px
  md: 4px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 18
  xl: 24
  xxl: 28
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#5266eb'
    textColor: '#ffffff'
    rounded: 4px
    padding: 10px 18px
    typography: 15px/480
    use: Single primary action Open Account
  button-secondary:
    type: button
    backgroundColor: '#ededf3'
    textColor: '#1e1e2a'
    rounded: 4px
    padding: 10px 18px
    typography: 15px/480
    use: Secondary action
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#5266eb'
    rounded: 4px
    padding: 10px 14px
    typography: 15px/420
    use: Inline low-emphasis Learn more
  email-pill:
    type: button
    backgroundColor: '#5266eb'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 0 20px
    typography: 15px/480
    use: Signature hero email-capture pill
  input:
    type: input
    backgroundColor: '#fbfcfd'
    textColor: '#1e1e2a'
    rounded: 4px
    padding: 10px 12px
    typography: 15px/400
    use: Standard dashboard field
  badge-neutral:
    type: badge
    backgroundColor: '#f4f5f9'
    textColor: '#70707d'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/480
    use: Category/status metadata
  badge-accent:
    type: badge
    textColor: '#5266eb'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/480
    use: Highlighted status New/Active
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 24px
    use: Dashboard panels, balance cards
  tab:
    type: tab
    backgroundColor: transparent
    textColor: '#70707d'
    active: '2px bottom border #5266eb'
    typography: 15px/480
    use: Dashboard section switching
  toast:
    type: toast
    backgroundColor: '#1e1e2a'
    textColor: '#ededf3'
    rounded: 12px
    padding: 12px 16px
    use: Transient confirmation
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 28px
    use: Confirmation/form modal
  toggle:
    type: toggle
    backgroundColor: '#5266eb'
    rounded: 9999px
    use: Boolean settings, on=indigo off=#c3c3cc
fonts:
  roles:
    sans: Arcadia
    mono: Arcadia Mono
---

# Mercury

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Mercury; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/mercury/DESIGN.md
