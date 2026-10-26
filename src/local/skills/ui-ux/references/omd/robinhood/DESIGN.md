---
name: Robinhood
colors:
  primary: '#00C805'
  primary-hover: '#00B004'
  primary-tint: '#E6FBE9'
  canvas-dark: '#0E0E0E'
  canvas: '#FFFFFF'
  ink: '#1B1B1B'
  loss: '#FF5000'
  warning: '#FFB000'
  info: '#2E6FF2'
  gray-50: '#F7F7F7'
  gray-100: '#EFEFEF'
  gray-200: '#E0E0E0'
  gray-400: '#A8A8A8'
  gray-500: '#8C8C8C'
  gray-600: '#6B6B6B'
  gray-700: '#4A4A4A'
  gray-800: '#2C2C2C'
  gray-900: '#1B1B1B'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.07
    letterSpacing: '-0.02px'
    use: Marketing hero headlines
  display-lg:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.02px'
    use: Section headers
  heading-lg:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.27
    letterSpacing: '-0.01px'
    use: Feature titles, modal headers
  heading:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-0.01px'
    use: Card headings, sub-sections
  subtitle:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.44
    use: List headers, nav titles
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.56
    use: Marketing body, explanations
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Secondary information
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Timestamps, disclosures, fine print
  number:
    fontSize: 40px
    fontWeight: 700
    letterSpacing: '-0.01px'
    use: Portfolio value, tabular numerals
rounded:
  sm: 8px
  md: 12px
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
    backgroundColor: '#00C805'
    textColor: '#0E0E0E'
    rounded: 9999px
    padding: 16px 28px
    typography: 16px/600 Capsule Sans
    use: Primary CTA, dark text on bright green
  button-secondary:
    type: button
    backgroundColor: '#FFFFFF'
    textColor: '#1B1B1B'
    rounded: 9999px
    padding: 16px 28px
    typography: 16px/600 Capsule Sans
    use: 'Outline secondary, 1.5px #E0E0E0 border'
  button-tertiary:
    type: button
    backgroundColor: '#FFFFFF'
    textColor: '#00B004'
    padding: 12px 8px
    typography: 16px/600 Capsule Sans
    use: Inline links, low-emphasis
  button-destructive:
    type: button
    backgroundColor: '#FF5000'
    textColor: '#FFFFFF'
    rounded: 12px
    padding: 16px 28px
    typography: 16px/600 Capsule Sans
    use: Sell confirmation, destructive flows
  input-text:
    type: input
    backgroundColor: '#FFFFFF'
    textColor: '#1B1B1B'
    rounded: 10px
    padding: 14px 16px
    typography: 16px/400 Capsule Sans
    use: 'Standard form input, 1.5px #E0E0E0 border, focus #00C805'
  card-standard:
    type: card
    backgroundColor: '#FFFFFF'
    rounded: 16px
    padding: 20px
    use: 'Holding, watchlist, account cards, 1px #E0E0E0 border'
  card-featured:
    type: card
    backgroundColor: '#0E0E0E'
    textColor: '#FFFFFF'
    rounded: 20px
    padding: 28px
    use: Promotional, Gold upsell, portfolio hero
  list-row:
    type: listItem
    rounded: 0px
    padding: 14px 16px
    use: 'Ticker rows, transaction history, bottom 1px #EFEFEF border'
  badge-gain:
    type: badge
    textColor: '#00B004'
    rounded: 8px
    padding: 3px 8px
    typography: 13px/600 Capsule Sans Mono
    use: Positive movement indicator
  badge-loss:
    type: badge
    textColor: '#FF5000'
    rounded: 8px
    padding: 3px 8px
    typography: 13px/600 Capsule Sans Mono
    use: Negative movement indicator
  badge-neutral:
    type: badge
    backgroundColor: '#EFEFEF'
    textColor: '#4A4A4A'
    rounded: 8px
    padding: 3px 8px
    typography: 12px/600 Capsule Sans
    use: NEW, category labels
  badge-gold:
    type: badge
    textColor: '#0E0E0E'
    rounded: 8px
    padding: 3px 8px
    typography: 12px/700 Capsule Sans
    use: Robinhood Gold marker, gold gradient
  tab-segmented:
    type: tab
    backgroundColor: '#EFEFEF'
    textColor: '#8C8C8C'
    rounded: 9999px
    padding: 6px 14px
    typography: 13px/600 Capsule Sans
    active: 'Active #FFFFFF bg + #1B1B1B text'
    use: Chart timeframe selector
  tab-bottom:
    type: tab
    backgroundColor: '#FFFFFF'
    textColor: '#A8A8A8'
    typography: 11px/500 Capsule Sans
    active: 'Active #00C805 icon + label'
    use: Primary mobile navigation
  toast-default:
    type: toast
    backgroundColor: '#1B1B1B'
    textColor: '#FFFFFF'
    rounded: 12px
    padding: 14px 18px
    typography: 14px/500 Capsule Sans
    use: Transient confirmation
  dialog-modal:
    type: dialog
    backgroundColor: '#FFFFFF'
    rounded: 20px
    padding: 28px
    use: Confirmations, disclosures
  dialog-sheet:
    type: dialog
    backgroundColor: '#FFFFFF'
    rounded: 20px
    padding: 24px 20px
    use: Trade ticket, order review, pickers, top corners only
  toggle-default:
    type: toggle
    backgroundColor: '#00C805'
    rounded: 9999px
    use: 'Boolean settings, #E0E0E0 off, #FFFFFF thumb'
fonts:
  roles:
    sans: Capsule Sans
    mono: Capsule Sans Mono
---

# Robinhood

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Robinhood; reproduced for educational reference. Full prose: https://oh-my-design.kr/robinhood/design.md
