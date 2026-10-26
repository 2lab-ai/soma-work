---
name: Studio
colors:
  primary: '#007cff'
  blue-light: '#4b9cfb'
  white: '#ffffff'
  off-white: '#f7f7f7'
  black: '#000000'
  ink: '#111111'
  error: '#f84f65'
  error-deep: '#b50000'
  caution: '#ffff99'
  grey-50: '#fafafa'
  grey-100: '#f5f5f5'
  grey-150: '#f2f2f2'
  grey-200: '#ededed'
  grey-250: '#e5e5e5'
  grey-300: '#eeeeee'
  grey-400: '#cccccc'
  grey-600: '#616161'
  grey-700: '#333333'
  grey-800: '#222222'
  grey-900: '#1a1a1a'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: '-0.03px'
    use: Landing hero headline
  display:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.02px'
    use: Major section openers
  heading-1:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '-0.02px'
    use: Page / panel titles
  heading-2:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.015px'
    use: Section headings
  heading-3:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: '-0.01px'
    use: Card / group titles
  subtitle:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.4
    use: List headers, nav labels
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: Marketing paragraphs
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    use: Standard UI text
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Secondary info
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0.01px
    use: Metadata, timestamps
  code:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: CSS values, tokens (Menlo)
rounded:
  sm: 4px
  md: 6px
  lg: 8px
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
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 6px
    padding: 0 18px
    typography: 14px/600 Inter
    use: 'Primary CTA, hover #000000'
  button-blue:
    type: button
    backgroundColor: '#007cff'
    textColor: '#ffffff'
    rounded: 6px
    padding: 0 18px
    typography: 14px/600 Inter
    use: Action emphasis inside editor
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 6px
    padding: 0 18px
    typography: 14px/500 Inter
    use: 'Outline, 1px #e5e5e5 border, hover #fafafa'
  button-ghost:
    type: button
    textColor: '#616161'
    rounded: 6px
    padding: 0 10px
    typography: 14px/500 Inter
    use: Tertiary / toolbar actions
  button-pill:
    type: badge
    textColor: '#4b9cfb'
    rounded: 9999px
    padding: 4px 12px
    typography: 12px/600 Inter
    use: New, Beta, category chips
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 6px
    padding: 9px 12px
    typography: 14px/400 Inter
    use: 'Standard form input, 1px #e5e5e5 border, focus #007cff'
  input-inset:
    type: input
    backgroundColor: '#f7f7f7'
    textColor: '#111111'
    rounded: 4px
    padding: 6px 8px
    typography: 13px/400 Inter
    use: Property/inspector value fields
  card-standard:
    type: card
    backgroundColor: '#ffffff'
    rounded: 6px
    padding: 20px
    use: 'Template tiles, project cards, 1px #eeeeee border, no shadow'
  card-floating:
    type: card
    backgroundColor: '#ffffff'
    rounded: 6px
    padding: 16px
    use: Popovers, inspector, floating menus
  card-showcase:
    type: card
    backgroundColor: '#f7f7f7'
    rounded: 6px
    padding: '0'
    use: Gallery tile, image-filled, hover scale 1.01
  badge-neutral:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#616161'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/500 Inter
    use: Tag, status metadata
  badge-accent:
    type: badge
    textColor: '#007cff'
    rounded: 9999px
    padding: 3px 10px
    typography: 12px/600 Inter
    use: New, highlighted category
  badge-error:
    type: badge
    textColor: '#f84f65'
    rounded: 4px
    padding: 2px 8px
    typography: 12px/600 Inter
    use: Failed / blocked state
  tab-underline:
    type: tab
    textColor: '#616161'
    padding: 0 4px 12px
    typography: 14px/500 Inter
    active: 'Active #111111 text + 2px #111111 bottom border'
    use: Section switching
  toast-default:
    type: toast
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 6px
    padding: 12px 16px
    typography: 14px/500 Inter
    use: Transient confirmation
  dialog-modal:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 6px
    padding: 24px
    use: Confirm / settings dialogs
  toggle-default:
    type: toggle
    backgroundColor: '#007cff'
    rounded: 9999px
    use: 'Boolean settings, #e5e5e5 off, #ffffff thumb'
fonts:
  roles:
    sans: Inter
    mono: Menlo
---

# Studio

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Studio; reproduced for educational reference. Full prose: https://oh-my-design.kr/studio/design.md
