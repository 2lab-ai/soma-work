---
name: Ramp
colors:
  primary: '#e5fe54'
  lime-hover: '#d4ed3f'
  lime-100: '#f4fcc9'
  lime-50: '#fbfee8'
  ink: '#1c1b17'
  ink-700: '#3d3c37'
  ink-600: '#56554f'
  canvas: '#f7f7f5'
  surface: '#ffffff'
  grey-500: '#74726b'
  grey-400: '#9c9a92'
  grey-300: '#c9c7bf'
  grey-200: '#e3e1da'
  grey-100: '#efeee9'
  success: '#1a7f4b'
  error: '#d93f3f'
  warning: '#e08a1e'
  info: '#2f6fe0'
  on-primary: '#1c1b17'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 400
    lineHeight: 1.06
    letterSpacing: '-0.02px'
    use: Marketing hero headlines (Burgess serif)
  display-lg:
    fontSize: 52px
    fontWeight: 400
    lineHeight: 1.12
    letterSpacing: '-0.02px'
    use: Section openers, editorial (serif)
  heading-1:
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.015px'
    use: Page titles in product
  heading-2:
    fontSize: 30px
    fontWeight: 500
    lineHeight: 1.27
    letterSpacing: '-0.01px'
    use: Section headers
  heading-3:
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.36
    letterSpacing: '-0.01px'
    use: Card titles, sub-sections
  subtitle:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.44
    use: Navigation, list headers
  body-lg:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.59
    use: Marketing body, descriptions
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.53
    use: Standard UI reading text
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.46
    use: Secondary info, table cells
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0.01px
    use: Timestamps, fine print, labels
  overline:
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.27
    letterSpacing: 0.08px
    use: Eyebrow labels, uppercase section tags
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
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#e5fe54'
    textColor: '#1c1b17'
    rounded: 8px
    padding: 0 20px
    typography: 15px / 500
    use: Primary CTA — Get started, Get a demo (44px)
  button-ink:
    type: button
    backgroundColor: '#1c1b17'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0 20px
    typography: 15px / 500
    use: Strong action on light surfaces, default product CTA
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1c1b17'
    rounded: 8px
    padding: 0 20px
    typography: 15px / 500
    use: 'Secondary action, 1px #c9c7bf border'
  button-ghost:
    type: button
    textColor: '#3d3c37'
    rounded: 8px
    padding: 0 12px
    typography: 15px / 500
    use: Low-emphasis inline (Cancel, Back)
  button-danger:
    type: button
    backgroundColor: '#d93f3f'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0 20px
    typography: 15px / 500
    use: Destructive confirmation
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1c1b17'
    rounded: 8px
    padding: 11px 14px
    typography: 15px / 400
    use: 'Standard form input, 1px #c9c7bf border, lime focus ring'
  input-filled:
    type: input
    backgroundColor: '#f7f7f5'
    textColor: '#1c1b17'
    rounded: 8px
    padding: 11px 14px
    typography: 15px / 400
    use: Dense forms, search bars
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 24px
    use: 'Workhorse surface — metrics, lists, panels, 1px #e3e1da border'
  card-savings:
    type: card
    backgroundColor: '#f4fcc9'
    rounded: 12px
    padding: 24px
    use: 'Savings callout, lime-tinted, 1px #e5fe54 border'
  card-dark:
    type: card
    backgroundColor: '#1c1b17'
    textColor: '#ffffff'
    rounded: 16px
    padding: 32px
    use: Marketing feature card, lime accents pop on black
  badge-lime:
    type: badge
    backgroundColor: '#e5fe54'
    textColor: '#1c1b17'
    rounded: 6px
    padding: 3px 8px
    typography: 12px / 600
    use: NEW / AI brand-emphasis tags
  badge-success:
    type: badge
    textColor: '#1a7f4b'
    rounded: 6px
    padding: 3px 8px
    typography: 12px / 600
    use: Approved, reconciled, savings confirmed
  badge-neutral:
    type: badge
    backgroundColor: '#efeee9'
    textColor: '#56554f'
    rounded: 6px
    padding: 3px 8px
    typography: 12px / 600
    use: Categories, metadata, default status
  tab:
    type: tab
    textColor: '#74726b'
    typography: 15px / 500
    use: In-page section switching
    active: '#1c1b17 text, 2px bottom border #1c1b17'
  segmented:
    type: tab
    backgroundColor: '#efeee9'
    rounded: 8px
    padding: 6px 14px
    typography: 14px / 500
    use: View toggles (Month / Quarter / Year)
    active: '#ffffff bg, #1c1b17 text'
  toast:
    type: toast
    backgroundColor: '#1c1b17'
    textColor: '#ffffff'
    rounded: 10px
    padding: 12px 16px
    typography: 14px / 500
    use: Transient confirmation, lime accent
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 28px
    use: Confirmations, create-card flow, approval prompts
  toggle:
    type: toggle
    backgroundColor: '#1c1b17'
    rounded: 9999px
    use: 'Boolean settings, white thumb, off #c9c7bf'
fonts:
  roles:
    sans: Lausanne
    serif: Burgess
    mono: Lausanne Mono
---

# Ramp

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ramp; reproduced for educational reference. Full prose: https://oh-my-design.kr/ramp/design.md
