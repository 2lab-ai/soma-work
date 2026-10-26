---
name: Stripe
colors:
  foreground: '#414552'
  foreground-strong: '#1a2c44'
  muted: '#50617a'
  link: '#5469d4'
  accent: '#533afd'
  canvas: '#ffffff'
  surface-subtle: '#f4f7fa'
  hairline: '#d4dee9'
  hairline-hover: '#95a4ba'
  on-dark: '#ffffff'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Repeated public Docs text; operating-system stack, not a named Stripe UI family
  heading:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    use: Observed Docs h1 only; not a complete display scale
  control:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Public Docs prompt, action, input, and tab samples
rounded:
  sm: 4px
  md: 6px
  lg: 8px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 12
  xl: 16
  xxl: 24
components:
  docs-search-prompt:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5469d4'
    rounded: 8px
    padding: 2px 8px
    typography: 14px/400 operating-system stack
    hover: '#273951 text with #95a4ba border'
    pressed: '#f4f7fa background with #3c4f69 text and #d4dee9 border'
    focus: captured without a distinct computed value
    states: focus, hover, pressed; home and payments only
    height: 32px
  docs-secondary-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#50617a'
    border: '0px #d4dee9'
    rounded: 8px
    padding: 6px 12px
    typography: 14px/400/20px operating-system stack
    hover: '#273951 text with #95a4ba border'
    pressed: '#f4f7fa background with #3c4f69 text'
    focus: '#f4f7fa background with #50617a text'
    states: focus, hover, pressed; home and payments only
  docs-content-tab:
    type: tab
    textColor: '#414552'
    rounded: 0px
    padding: 0px
    typography: 14px/400 operating-system stack
    states: selected; static aria-tab capture on Docs home and payments
---

# Stripe

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Stripe; reproduced for educational reference. Full prose: https://oh-my-design.kr/stripe/design.md
