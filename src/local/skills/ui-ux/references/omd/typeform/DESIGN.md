---
name: Typeform
colors:
  primary: '#2a222b'
  foreground: '#2a222b'
  canvas: '#faf9fb'
  ink-hover: '#564b58'
  surface-active: '#eeecee'
  surface-hover: '#f5f3f6'
  text-secondary: '#655d67'
  border: '#e5e1e5'
  neutral-500: '#a49da6'
  highlight: '#9454ab'
  eyebrow: '#a25fba'
  lavender-300: '#ddd6fa'
  lavender-500: '#a494eb'
  lavender-700: '#7761b3'
  lavender-900: '#42377b'
  white: '#ffffff'
typography:
  button:
    fontSize: 16px
    fontWeight: 400
    use: buttons
rounded:
  xs: 4px
  sm: 12px
  md: 24px
  lg: 48px
  xl: 80px
  full: 16000px
components:
  button-light:
    type: button
    backgroundColor: '#faf9fb'
    textColor: '#2a222b'
    border: '#2a222b'
    rounded: 12px
    height: 48px
    padding: 8px 24px
    typography: 16px / 400
    hover: '#eeecee'
    pressed: '#eeecee'
    use: 'Get started — Paper with an Ink label; hover and press fill it with --tokens--button--secondary-bg-hover #eeecee. Focus is the browser''s ring. A 40px Sign up variant follows the same recipe.'
  button-dark:
    type: button
    backgroundColor: '#2a222b'
    textColor: '#faf9fb'
    rounded: 12px
    height: 48px
    padding: 8px 24px
    typography: 16px / 400
    hover: '#564b58'
    pressed: '#564b58'
    use: 'Explore forms — Ink with a Paper label (--tokens--button--primary-bg-idle); hover and press lift it to --tokens--button--primary-bg-hover #564b58. Focus is the browser''s ring.'
  link-login:
    type: button
    backgroundColor: transparent
    textColor: '#faf9fb'
    rounded: 0px
    height: 48px
    padding: 0 12px
    typography: 16px / 400
    hover: 'fg #ddb7f0'
    pressed: 'fg #ddb7f0'
    use: 'Log in in the header over the dark hero — Paper text that turns lavender #ddb7f0 on hover and press.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Tobias
    sans: TWK Lausanne
---

# Typeform

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Typeform; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/typeform/DESIGN.md
