---
name: Starbucks
colors:
  primary: '#00704A'
  accent-green: '#00a862'
  deep-forest: '#1e3932'
  warm-white: '#f1f8f4'
  white: '#fafafa'
  cream: '#ede9e1'
  latte: '#d4e9e2'
  gold: '#cba258'
  berry: '#c44d58'
  success: '#00754a'
  error: '#e75b52'
  black: '#000000'
  charcoal: '#1e1e1e'
  body: '#4a4a4a'
  secondary: '#6b6b6b'
  disabled: '#8c8c8c'
  border: '#d4d4d4'
  light-gray: '#e8e8e8'
  bg-gray: '#f2f0eb'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: '-0.5px'
    use: Campaign hero headlines (Pike/Lander)
  display-lg:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: '-0.25px'
    use: Page titles, section openers
  heading-1:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    use: Major section headings
  heading-2:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.36
    use: Card headings, sub-sections
  heading-3:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.44
    use: List headers, menu item names
  subtitle:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: Navigation, emphasized labels
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: Descriptions, product copy
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Standard reading text
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.2px
    use: Metadata, fine print, legal
  button:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.3px
    use: Button labels
rounded:
  sm: 4px
  md: 16px
  lg: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 96
components:
  button-primary:
    type: button
    backgroundColor: '#00704A'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 12px 24px
    typography: 14px/600 SoDo Sans
    use: 'Primary CTA pill, hover #1e3932'
  button-secondary:
    type: button
    textColor: '#00704A'
    rounded: 9999px
    padding: 12px 24px
    typography: 14px/600 SoDo Sans
    use: 'Outlined green pill, 1px #00704A border'
  button-tertiary:
    type: button
    textColor: '#00704A'
    padding: 8px 12px
    typography: 14px/600 SoDo Sans
    use: Low-emphasis inline action, underline on hover
  button-dark:
    type: button
    backgroundColor: '#fafafa'
    textColor: '#00704A'
    rounded: 9999px
    padding: 12px 24px
    typography: 14px/600 SoDo Sans
    use: Primary CTA on deep-forest or photo dark section
  button-gold:
    type: button
    backgroundColor: '#cba258'
    textColor: '#1e3932'
    rounded: 9999px
    padding: 12px 24px
    typography: 14px/700 SoDo Sans
    use: Rewards/loyalty CTA
  input-text:
    type: input
    textColor: '#1e1e1e'
    rounded: 4px
    padding: 14px 16px
    typography: 16px/400 SoDo Sans
    use: 'Standard form input, 1px #8c8c8c border, focus 2px #00704A'
  input-search:
    type: input
    backgroundColor: '#f2f0eb'
    rounded: 9999px
    padding: 12px 20px
    typography: 16px/400 SoDo Sans
    use: Store locator, menu search pill
  card-product:
    type: card
    rounded: 16px
    padding: 16px
    use: 'Menu item, product, promo tile, 1px #e8e8e8 border, top full-bleed image'
  card-editorial:
    type: card
    backgroundColor: '#f1f8f4'
    rounded: 20px
    padding: 32px
    use: Story blocks, campaign features, flat warm surface
  card-rewards:
    type: card
    textColor: '#ffffff'
    rounded: 16px
    padding: 24px
    use: Loyalty balance, star count, green-to-forest gradient
  badge-status:
    type: badge
    backgroundColor: '#00704A'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 4px 12px
    typography: 11px/700 SoDo Sans
    use: NEW, LIMITED TIME, uppercase
  badge-gold:
    type: badge
    backgroundColor: '#cba258'
    textColor: '#1e3932'
    rounded: 9999px
    padding: 4px 12px
    typography: 11px/700 SoDo Sans
    use: Star earnings, member-exclusive
  badge-subtle:
    type: badge
    backgroundColor: '#d4e9e2'
    textColor: '#00704A'
    rounded: 9999px
    padding: 4px 12px
    typography: 11px/600 SoDo Sans
    use: Category labels, dietary tags
  toast-default:
    type: toast
    backgroundColor: '#1e3932'
    textColor: '#ffffff'
    rounded: 8px
    padding: 14px 18px
    typography: 14px/600 SoDo Sans
    use: Transient confirmation
  toast-success:
    type: toast
    backgroundColor: '#d4e9e2'
    textColor: '#00704A'
    rounded: 8px
    padding: 12px 16px
    use: 'Persistent success banner, 4px #00704A left border'
  dialog-modal:
    type: dialog
    textColor: '#1e1e1e'
    rounded: 16px
    padding: 32px
    use: Confirmation, store selection, green-tinted scrim
  toggle-switch:
    type: toggle
    backgroundColor: '#00704A'
    rounded: 9999px
    use: 'Preference settings, #d4d4d4 off, #ffffff thumb'
fonts:
  roles:
    sans: SoDo Sans
    mono: SoDo Sans
---

# Starbucks

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Starbucks; reproduced for educational reference. Full prose: https://oh-my-design.kr/starbucks/design.md
