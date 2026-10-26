---
name: Meta
colors:
  primary: '#0064e0'
  primary-light: '#0082fb'
  primary-bright: '#0080fb'
  primary-pressed: '#0058c4'
  canvas: '#ffffff'
  ink: '#1c2b33'
  ink-800: '#2d3a42'
  gray-700: '#465a69'
  gray-600: '#65676b'
  gray-500: '#8a8d91'
  gray-400: '#bcc0c4'
  border: '#e4e6eb'
  border-strong: '#ced0d4'
  canvas-gray: '#f0f2f5'
  surface-tint: '#f7f8fa'
  success: '#42b72a'
  success-text: '#2e8b1e'
  error: '#fa383e'
  warning: '#f5a623'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.07
    letterSpacing: '-0.02px'
    use: Marketing hero, Optimistic Display
  display-lg:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.01px'
    use: Section headers
  display:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.01px'
    use: Feature titles
  heading:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    use: Card headings, modal titles
  subtitle:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    use: Sub-section, list headers
  body-lg:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.53
    use: Lead paragraphs
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.47
    use: Standard reading text
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Secondary info
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Timestamps, fine print
  button:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.33
    use: CTA labels
rounded:
  sm: 6px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 28
  xxl: 32
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#0064e0'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 20px
    typography: 15px/600
    use: Product-surface primary action
  button-secondary:
    type: button
    backgroundColor: '#e4e6eb'
    textColor: '#1c2b33'
    rounded: 8px
    padding: 12px 20px
    typography: 15px/600
    use: Neutral secondary
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#0064e0'
    rounded: 8px
    padding: 12px 24px
    typography: 15px/600
    use: Tertiary CTA Sign up
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1c2b33'
    rounded: 8px
    padding: 12px 14px
    typography: 15px/400
    use: Standard form input
  input-filled:
    type: input
    backgroundColor: '#f0f2f5'
    textColor: '#1c2b33'
    rounded: 8px
    padding: 12px 14px
    typography: 15px/400
    use: Search bars, dense forms
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 16px
    use: Feed cards, content panels
  badge-notif:
    type: badge
    backgroundColor: '#fa383e'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 2px 6px
    typography: 12px/700
    use: Unread count red dot
  badge-status:
    type: badge
    textColor: '#0064e0'
    rounded: 9999px
    padding: 4px 10px
    typography: 12px/600
    use: Soft informational label New
  tab:
    type: tab
    backgroundColor: transparent
    textColor: '#65676b'
    active: '3px bottom border #0064e0 with #0064e0 text'
    typography: 15px/600
    use: In-page section nav
  segmented:
    type: tab
    backgroundColor: '#f0f2f5'
    textColor: '#65676b'
    rounded: 8px
    padding: 8px 16px
    active: '#ffffff bg with #1c2b33 text'
    typography: 14px/600
    use: Mode switching
  toast:
    type: toast
    backgroundColor: '#1c2b33'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    typography: 14px/500
    use: Transient confirmation Link copied
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#1c2b33'
    rounded: 12px
    padding: 24px
    use: Confirmations, composer dialogs
  toggle:
    type: toggle
    backgroundColor: '#0064e0'
    rounded: 9999px
    use: Boolean settings, on=blue off=#bcc0c4
fonts:
  roles:
    sans: Optimistic Text
    mono: SF Mono
---

# Meta

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Meta; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/meta/DESIGN.md
