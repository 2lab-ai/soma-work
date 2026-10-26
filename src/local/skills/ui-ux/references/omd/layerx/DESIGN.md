---
name: LayerX
colors:
  primary: '#534dff'
  primary-hover: '#403ae6'
  primary-tint: '#eeedff'
  canvas: '#ffffff'
  ink: '#152632'
  sky: '#8dbbff'
  gradient-end: '#7b6cff'
  error: '#e5484d'
  success: '#1fa971'
  warning: '#f5a623'
  info: '#3e63dd'
  grey-50: '#f7f8fa'
  grey-100: '#f0f2f5'
  grey-200: '#e3e6eb'
  grey-300: '#cbd1d9'
  grey-400: '#9aa4b2'
  grey-500: '#6b7585'
  grey-600: '#4a5360'
  grey-700: '#333b45'
  grey-800: '#1f2832'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.02px'
    use: Landing hero headline
  display:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.02px'
    use: Section headers
  heading-1:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.43
    letterSpacing: '-0.01px'
    use: Feature titles
  heading-2:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: '-0.01px'
    use: Card/block headings
  heading-3:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.56
    use: Sub-sections
  subtitle:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.63
    use: List headers, labels
  body-large:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.75
    use: Lead paragraphs
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.73
    use: Standard reading text
  body-small:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Secondary text
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.01px
    use: Timestamps, fine print
  amount:
    fontSize: 24px
    fontWeight: 600
    use: Invoice & financial figures, tabular nums
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
  section: 96
components:
  button-primary:
    type: button
    backgroundColor: '#534dff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0 24px
    typography: 15px/600
    use: Primary CTA, 44px height
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#534dff'
    rounded: 8px
    padding: 0 24px
    typography: 15px/600
    use: Secondary paired action, 1px indigo border
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#333b45'
    rounded: 8px
    padding: 0 16px
    typography: 15px/600
    use: Low-emphasis nav actions
  button-danger:
    type: button
    backgroundColor: '#e5484d'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0 24px
    typography: 15px/600
    use: Destructive confirmation
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1f2832'
    rounded: 8px
    padding: 11px 14px
    typography: 15px/400
    use: Standard form field
  input-select:
    type: input
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 11px 14px
    use: Single choice from list
  card-standard:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 24px
    use: Feature blocks, content panels
  card-featured:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 32px
    use: Hero/marketing cards, pricing highlight
  card-compact:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 16px
    use: List rows, dense cards
  badge-brand:
    type: badge
    backgroundColor: '#534dff'
    textColor: '#ffffff'
    rounded: 6px
    padding: 2px 8px
    typography: 12px/600
    use: Primary emphasis NEW
  badge-soft-brand:
    type: badge
    backgroundColor: '#eeedff'
    textColor: '#403ae6'
    rounded: 6px
    padding: 2px 8px
    typography: 12px/600
    use: Subtle category/status tag
  badge-success:
    type: badge
    textColor: '#1fa971'
    rounded: 6px
    padding: 2px 8px
    typography: 12px/600
    use: Approved/completed
  tab-underline:
    type: tab
    backgroundColor: transparent
    textColor: '#6b7585'
    padding: 12px 16px
    typography: 15px/600
    active: '#534dff text + 2px bottom border #534dff'
    use: Section navigation
  tab-segmented:
    type: tab
    backgroundColor: '#f0f2f5'
    textColor: '#6b7585'
    rounded: 8px
    padding: 8px 16px
    typography: 14px/600
    active: '#ffffff bg + #152632 text'
    use: View switching
  toast-default:
    type: toast
    backgroundColor: '#152632'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    typography: 14px/500
    use: Transient auto-dismiss notification
  dialog-modal:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#152632'
    rounded: 16px
    padding: 32px
    use: Confirmation, forms, detail overlays
  dialog-drawer:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: 24px
    use: Side panel, detail view, filters
  toggle-default:
    type: toggle
    backgroundColor: '#534dff'
    rounded: 9999px
    use: 'Boolean settings, feature flags (off #cbd1d9)'
fonts:
  roles:
    sans: Inter
    mono: SF Mono
---

# LayerX

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to LayerX; reproduced for educational reference. Full prose: https://oh-my-design.kr/layerx/design.md
