---
name: Mastercard
colors:
  primary: '#141413'
  primary-hover: '#333333'
  brand: '#EB001B'
  brand-hover: '#C8001A'
  accent-yellow: '#F79E1B'
  accent-orange: '#FF5F00'
  canvas: '#FFFFFF'
  surface: '#F7F7F7'
  foreground: '#141413'
  body: '#5A5A5A'
  muted: '#767676'
  placeholder: '#999999'
  hairline: '#E0E0E0'
  border-strong: '#CCCCCC'
  on-primary: '#FFFFFF'
  success: '#008A00'
  error: '#EB001B'
  info: '#1A73E8'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.14
    letterSpacing: '-0.02px'
    use: Marketing hero headlines
  display-large:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.01px'
    use: Page titles, key statements
  heading-1:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.01px'
    use: Section headers
  heading-2:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    use: Sub-sections, card headers
  heading-3:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    use: Feature titles, list headers
  subtitle:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.44
    use: Lead paragraphs, intros
  body-large:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: Primary reading text
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Standard UI text
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.01px
    use: Legal, fine print, metadata
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.01px
    use: CTA labels
  eyebrow:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: 0.08px
    use: UPPERCASE section kickers
rounded:
  sm: 4px
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
  hero: 96
components:
  button-primary:
    type: button
    backgroundColor: '#141413'
    textColor: '#FFFFFF'
    rounded: 24px
    height: 48px
    padding: 0 28px
    typography: 16px / 600
    hover: '#333333'
    active: '#000000'
    disabled: '#CCCCCC bg, #767676 text'
    use: Primary CTA across most surfaces
  button-red:
    type: button
    backgroundColor: '#EB001B'
    textColor: '#FFFFFF'
    rounded: 24px
    height: 48px
    padding: 0 28px
    typography: 16px / 600
    hover: '#C8001A'
    active: '#A30016'
    use: High-emphasis brand-forward CTA, hero action
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#141413'
    border: '1.5px solid #141413'
    rounded: 24px
    height: 48px
    padding: 0 28px
    typography: 16px / 600
    hover: '#F7F7F7 bg'
    use: Secondary action paired with primary
  button-tertiary:
    type: button
    backgroundColor: none
    textColor: '#EB001B'
    typography: 16px / 600
    hover: 'underline + #C8001A'
    use: Inline navigation, Read more, low-emphasis
  input:
    type: input
    backgroundColor: '#FFFFFF'
    textColor: '#141413'
    border: '1px solid #CCCCCC'
    rounded: 8px
    padding: 14px 16px
    typography: 16px / 400
    focus: '2px #141413 border + outer ring'
    use: Standard form input
  input-error:
    type: input
    border: '2px solid #EB001B'
    typography: '12px / 400 #EB001B helper'
    use: Validation failure
  search:
    type: input
    backgroundColor: '#F7F7F7'
    border: 1px solid transparent
    rounded: 9999px
    focus: '#CCCCCC border'
    use: Global site/product search, leading magnifier
  card:
    type: card
    backgroundColor: '#FFFFFF'
    border: '1px solid #E0E0E0'
    rounded: 12px
    padding: 24px
    shadow: 0 1px 3px rgba(0,0,0,0.08)
    use: Content modules, feature tiles
  card-elevated:
    type: card
    backgroundColor: '#FFFFFF'
    rounded: 16px
    padding: 32px
    shadow: 0 4px 16px rgba(0,0,0,0.10)
    use: Promotional / hero cards
  card-stat:
    type: card
    backgroundColor: '#F7F7F7'
    rounded: 12px
    padding: 24px
    use: Metrics, data highlights — number 40px / 700, brand-gradient top bar
  badge-brand:
    type: badge
    backgroundColor: '#EB001B'
    textColor: '#FFFFFF'
    rounded: 4px
    padding: 4px 8px
    typography: 12px / 700
    use: NEW, FEATURED uppercase 0.04em
  badge-neutral:
    type: badge
    backgroundColor: '#F0F0F0'
    textColor: '#333333'
    rounded: 9999px
    padding: 4px 12px
    typography: 13px / 500
    use: Category, filter chips
  badge-success:
    type: badge
    backgroundColor: rgba(0,138,0,0.12)
    textColor: '#008A00'
    rounded: 4px
    typography: 12px / 700
    use: Approved, Completed
  tab:
    type: tab
    textColor: '#5A5A5A'
    typography: 16px / 500
    active: '#141413 16px / 600, 3px bottom border #EB001B'
    use: Section navigation within a page
  alert:
    type: toast
    backgroundColor: '#F7F7F7'
    border: 4px left semantic color
    rounded: 8px
    padding: 16px
    typography: '14px / 400 #333333'
    use: Form-level and page-level messaging
  dialog:
    type: dialog
    backgroundColor: '#FFFFFF'
    rounded: 16px
    padding: 32px
    shadow: 0 16px 48px rgba(0,0,0,0.20)
    use: Confirmations, focused tasks; backdrop rgba(20,20,19,0.6)
  toggle:
    type: toggle
    backgroundColor: '#CCCCCC track off, #141413 track on'
    rounded: 9999px
    use: 'Settings, preferences; thumb #FFFFFF 20px'
fonts:
  roles:
    sans: Mark
    mono: SF Mono
---

# Mastercard

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Mastercard; reproduced for educational reference. Full prose: https://oh-my-design.kr/mastercard/design.md
