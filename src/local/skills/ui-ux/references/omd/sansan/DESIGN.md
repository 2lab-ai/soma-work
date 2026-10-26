---
name: Sansan
colors:
  primary: '#E60012'
  primary-hover: '#cc0010'
  primary-tint: '#fdecec'
  canvas: '#ffffff'
  ink: '#1a1a1a'
  ink-black: '#222222'
  orange: '#f5821f'
  blue: '#0a6ebd'
  error: '#d32f2f'
  success: '#2e9e5b'
  warning: '#f5a623'
  grey-50: '#f7f8fa'
  grey-100: '#eef0f3'
  grey-200: '#e1e4e8'
  grey-300: '#cbd0d6'
  grey-400: '#9aa1aa'
  grey-500: '#6b727c'
  grey-600: '#4a5159'
  grey-700: '#33383f'
  grey-900: '#1a1a1a'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.01px'
    use: Landing hero headline
  display-lg:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.01px'
    use: Section openers
  heading-1:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.43
    use: Page titles
  heading-2:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.45
    use: Sub-sections, modal headers
  heading-3:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.55
    use: Card titles
  subtitle:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.62
    use: List headers, lead-ins
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.75
    use: Marketing body, descriptions
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.71
    use: Standard UI reading text
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.62
    use: Secondary info
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Timestamps, fine print, labels
rounded:
  sm: 4px
  md: 6px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 24
  lg: 32
  xl: 48
  xxl: 64
  section: 96
components:
  button-primary:
    type: button
    backgroundColor: '#E60012'
    textColor: '#ffffff'
    rounded: 4px
    padding: 14px 28px
    typography: 16px/700 Hiragino
    use: 'Primary CTA, hover #cc0010'
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#E60012'
    rounded: 4px
    padding: 13px 27px
    typography: 16px/700 Hiragino
    use: 'Outline red, 1.5px #E60012 border, hover #fdecec'
  button-neutral:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#33383f'
    rounded: 4px
    padding: 13px 27px
    typography: 16px/600 Hiragino
    use: 'Cancel, back, 1px #cbd0d6 border'
  button-ghost:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#E60012'
    padding: 8px 4px
    typography: 15px/600 Hiragino
    use: Inline text link with arrow glyph
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 4px
    padding: 12px 14px
    typography: 15px/400 Hiragino
    use: 'Standard form input, 1px #cbd0d6 border, focus #E60012'
  input-filled:
    type: input
    backgroundColor: '#f7f8fa'
    textColor: '#1a1a1a'
    rounded: 4px
    padding: 12px 14px
    use: 'In-product dense forms, focus #ffffff bg + #E60012 border'
  card-standard:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 24px
    use: 'Content panels, 1px #e1e4e8 border'
  card-elevated:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 32px
    use: Hero feature, pricing tiers
  card-list:
    type: listItem
    backgroundColor: '#ffffff'
    rounded: 6px
    padding: 16px
    use: 'Dense list rows, contact records, 1px #e1e4e8 border'
  card-highlighted:
    type: card
    backgroundColor: '#fdecec'
    rounded: 8px
    padding: 24px
    use: 'Recommended tier, selected, 1px #E60012 border'
  badge-brand:
    type: badge
    backgroundColor: '#E60012'
    textColor: '#ffffff'
    rounded: 4px
    padding: 3px 8px
    typography: 12px/700 Hiragino
    use: NEW, おすすめ, featured
  badge-soft:
    type: badge
    backgroundColor: '#fdecec'
    textColor: '#cc0010'
    rounded: 4px
    padding: 3px 8px
    typography: 12px/700 Hiragino
    use: Subtle category/status tag
  badge-neutral:
    type: badge
    backgroundColor: '#eef0f3'
    textColor: '#4a5159'
    rounded: 4px
    padding: 3px 8px
    typography: 12px/600 Hiragino
    use: Metadata, tag chips, filter labels
  badge-success:
    type: badge
    textColor: '#2e9e5b'
    rounded: 4px
    padding: 3px 8px
    use: 登録済み, completion state
  tab-underline:
    type: tab
    textColor: '#6b727c'
    padding: 12px 20px
    typography: 15px/600 Hiragino
    active: 'Active #1a1a1a text + 2px #E60012 bottom border'
    use: In-product section switching
  tab-segmented:
    type: tab
    backgroundColor: '#eef0f3'
    rounded: 6px
    padding: 8px 16px
    typography: 14px/600
    active: 'Active #ffffff bg + #1a1a1a text'
    use: Compact view toggles
  toast-default:
    type: toast
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 6px
    padding: 12px 16px
    typography: 14px/500
    use: Transient confirmation, 3s auto-dismiss
  toast-success:
    type: toast
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 6px
    padding: 12px 16px
    use: 'Inline success banner, 4px #2e9e5b left border'
  dialog-modal:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 12px
    padding: 32px
    use: Confirmation prompts, forms, detail overlays
  toggle-switch:
    type: toggle
    backgroundColor: '#E60012'
    rounded: 9999px
    use: 'Boolean settings, #cbd0d6 off, #ffffff thumb'
fonts:
  roles:
    sans: Hiragino Kaku Gothic ProN
    mono: SF Mono
---

# Sansan

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Sansan; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/sansan/DESIGN.md
