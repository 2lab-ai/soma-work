---
name: OpenAI
colors:
  primary: '#10a37f'
  primary-hover: '#1a7f64'
  primary-tint: '#d9f2ea'
  canvas: '#ffffff'
  ink: '#0d0d0d'
  brand-black: '#000000'
  error: '#ef4146'
  warning: '#f5a623'
  info: '#4d6bfe'
  gray-50: '#f7f7f8'
  gray-100: '#ececec'
  gray-200: '#e5e5e5'
  gray-300: '#d1d1d1'
  gray-400: '#b4b4b4'
  gray-500: '#9b9b9b'
  gray-600: '#6e6e80'
  gray-700: '#40414f'
  gray-800: '#2d2d2d'
  surface-base: '#212121'
  surface-sunken: '#171717'
  surface-raised: '#2f2f2f'
  dark-border: '#3e3e42'
  amber-bg: '#fdf0d5'
  amber-text: '#b8770f'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 600
    lineHeight: 1.07
    letterSpacing: '-0.02em'
    use: Marketing hero, launch pages
  display-lg:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: '-0.02em'
    use: Section headers
  h1:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.01em'
    use: Page titles
  h2:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-0.01em'
    use: Sub-sections, card titles
  h3:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    use: Group labels, modal headers
  subtitle:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.56
    use: Lead paragraphs, list headers
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: Marketing body, descriptions
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    use: Standard reading text, chat
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Secondary info, dense UI
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Timestamps, metadata, helper
  code:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Code blocks, tokens, IDs
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  sm: 8
  md: 12
  base: 16
  lg: 24
components:
  button-primary:
    type: button
    backgroundColor: '#0d0d0d'
    textColor: '#ffffff'
    rounded: 12px
    padding: 0 20px
    typography: 15px/500
    use: Default primary action
  button-teal:
    type: button
    backgroundColor: '#10a37f'
    textColor: '#ffffff'
    rounded: 12px
    padding: 0 20px
    typography: 15px/500
    use: Brand-forward conversion CTA
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0d0d0d'
    rounded: 12px
    padding: 0 20px
    typography: 15px/500
    use: Secondary action
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#0d0d0d'
    rounded: 8px
    padding: 0 12px
    typography: 14px/500
    use: Low-emphasis inline action
  pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0d0d0d'
    rounded: 9999px
    padding: 8px 16px
    typography: 14px/400
    use: Prompt-suggestion chip, filter, model selector
  chat-composer:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0d0d0d'
    rounded: 26px
    padding: 14px 18px
    typography: 16px/400
    use: Signature ChatGPT message input
  form-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0d0d0d'
    rounded: 8px
    padding: 10px 12px
    typography: 15px/400
    use: Settings, API keys, account forms
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 24px
    use: Docs cards, pricing, model cards
  card-dark:
    type: card
    backgroundColor: '#2f2f2f'
    rounded: 12px
    padding: 24px
    use: Cards on dark canvas
  user-message:
    type: listItem
    backgroundColor: '#f7f7f8'
    textColor: '#0d0d0d'
    rounded: 18px
    padding: 10px 16px
    use: ChatGPT user turn bubble
  badge-neutral:
    type: badge
    backgroundColor: '#ececec'
    textColor: '#40414f'
    rounded: 6px
    padding: 2px 8px
    typography: 12px/500
    use: Model labels, version tags
  badge-teal:
    type: badge
    backgroundColor: '#d9f2ea'
    textColor: '#1a7f64'
    rounded: 6px
    padding: 2px 8px
    typography: 12px/500
    use: New, Plus, positive emphasis
  badge-amber:
    type: badge
    backgroundColor: '#fdf0d5'
    textColor: '#b8770f'
    rounded: 6px
    padding: 2px 8px
    typography: 12px/500
    use: Preview, Rate limited, caution
  tab-underline:
    type: tab
    backgroundColor: transparent
    textColor: '#6e6e80'
    typography: 15px/500
    use: Docs, settings, API reference
    active: '#0d0d0d text, 2px bottom border #0d0d0d'
  segmented:
    type: tab
    backgroundColor: '#ececec'
    textColor: '#6e6e80'
    rounded: 8px
    typography: 14px/500
    use: Mode/plan toggle
    active: '#ffffff bg, #0d0d0d text'
  toast:
    type: toast
    backgroundColor: '#0d0d0d'
    textColor: '#ffffff'
    rounded: 10px
    padding: 12px 16px
    typography: 14px/400
    use: Transient confirmation (Copied, Saved)
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 24px
    use: Confirmations, settings, upgrade prompts
  toggle:
    type: toggle
    backgroundColor: '#10a37f'
    rounded: 9999px
    use: Boolean settings, on=teal off=#d1d1d1
fonts:
  roles:
    sans: OpenAI Sans
    mono: SF Mono
---

# OpenAI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to OpenAI; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/openai/DESIGN.md
