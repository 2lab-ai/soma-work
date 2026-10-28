---
name: GOV.UK
colors:
  primary: '#1d70b8'
  primary-hover: '#0f385c'
  brand: '#1d70b8'
  action: '#0f7a52'
  action-shadow: '#083d29'
  action-secondary: '#f3f3f3'
  action-secondary-shadow: '#858686'
  action-warning: '#ca3535'
  action-warning-shadow: '#651b1b'
  canvas: '#ffffff'
  foreground: '#0b0c0c'
  secondary-text: '#484949'
  surface: '#f4f8fb'
  surface-alt: '#f3f3f3'
  hairline: '#cecece'
  input-border: '#0b0c0c'
  focus: '#ffdd00'
  focus-text: '#0b0c0c'
  error: '#ca3535'
  success: '#0f7a52'
  visited: '#54319f'
  on-primary: '#ffffff'
  tag-default-bg: '#d2e2f1'
  tag-default-fg: '#0f385c'
  notification-banner: '#1d70b8'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.1
    use: GOV.UK homepage H1 — 'The best place to find government services'
  heading-xl:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.15
    use: DS H1 major headings
  heading-l:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.11
    use: H2 section headings
  heading-m:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.25
    use: H3 sub-section headings
  heading-s:
    fontSize: 19px
    fontWeight: 700
    lineHeight: 1.31
    use: H4 small headings
  body-l:
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.31
    use: Lead paragraph and button labels
  body-m:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.25
    use: Standard body text
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Captions, metadata
rounded:
  sm: 0px
  md: 0px
  lg: 0px
  full: 1px
spacing:
  xs: 5
  sm: 10
  md: 15
  base: 20
  lg: 30
  xl: 40
  xxl: 60
  section: 80
components:
  button-primary:
    type: button
    backgroundColor: '#0f7a52'
    textColor: '#ffffff'
    rounded: 0px
    padding: 8px 10px 7px
    height: 38px
    typography: 19px / 400 GDS Transport
    shadow: '0 2px 0 #083d29'
    use: Primary CTA — Save and continue, Start now
  button-secondary:
    type: button
    backgroundColor: '#f3f3f3'
    textColor: '#0b0c0c'
    rounded: 0px
    padding: 8px 10px 7px
    height: 38px
    typography: 19px / 400 GDS Transport
    shadow: '0 2px 0 #858686'
    use: Secondary action — Find address
  button-warning:
    type: button
    backgroundColor: '#ca3535'
    textColor: '#ffffff'
    rounded: 0px
    padding: 8px 10px 7px
    height: 38px
    typography: 19px / 400 GDS Transport
    shadow: '0 2px 0 #651b1b'
    use: Destructive — Delete account
  text-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0b0c0c'
    border: '2px solid #0b0c0c'
    rounded: 0px
    padding: 5px
    height: 40px
    typography: 19px / 400 GDS Transport
    focus: '#ffdd00 3px outline'
    use: Standard text input field
  select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0b0c0c'
    border: '2px solid #0b0c0c'
    rounded: 0px
    padding: 5px
    height: 40px
    typography: 19px / 400 GDS Transport
    use: Native select control
  tag:
    type: badge
    backgroundColor: '#d2e2f1'
    textColor: '#0f385c'
    rounded: 1px
    padding: 2px 8px 3px
    typography: 19px / 400 GDS Transport
    use: Status tag — Completed, In progress, Not started
  notification-banner:
    type: toast
    backgroundColor: '#1d70b8'
    textColor: '#ffffff'
    border: '5px solid #1d70b8'
    rounded: 0px
    use: Top-of-page notification banner (informational / success)
  inset-text:
    type: card
    backgroundColor: transparent
    textColor: '#0b0c0c'
    border: '10px solid #cecece'
    rounded: 0px
    padding: 15px
    use: Inset text panel for important supplementary information
  cookie-banner:
    type: dialog
    backgroundColor: '#0f7a52'
    textColor: '#ffffff'
    rounded: 0px
    padding: 8px 10px 7px
    use: Cookie consent action buttons (green)
fonts:
  roles:
    sans: GDS Transport
    fallback: arial, sans-serif
---

# GOV.UK

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to GOV.UK; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/govuk/DESIGN.md
