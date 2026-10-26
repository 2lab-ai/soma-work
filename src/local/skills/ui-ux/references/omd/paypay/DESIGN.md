---
name: PayPay
colors:
  primary: '#ff0033'
  primary-pressed: '#e0002e'
  primary-deep: '#cc0029'
  primary-tint: '#ffebef'
  primary-disabled: '#ffb3c1'
  canvas: '#ffffff'
  ink: '#222222'
  success: '#00b900'
  error: '#e0002e'
  warning: '#ff8800'
  info: '#0088ff'
  point-gold: '#ffb200'
  gray-50: '#f5f5f5'
  gray-100: '#eeeeee'
  gray-200: '#e0e0e0'
  gray-300: '#cccccc'
  gray-400: '#999999'
  gray-500: '#767676'
  gray-700: '#555555'
typography:
  display-hero:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.38
    use: Splash, campaign hero, big point moments
  balance:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    use: Wallet balance, the emotional center
  display-lg:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.42
    use: Section headers, key metrics
  heading-lg:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: Feature titles, modal headers
  heading:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.44
    use: Card headings, sub-sections
  subtitle:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: List headers, nav titles
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: Descriptions, explanations
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Standard reading text
  body-sm:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.54
    use: Secondary information
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Timestamps, fine print, legal
  amount-hero:
    fontSize: 36px
    fontWeight: 700
    use: Payment amount on checkout/complete
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  full: 9999px
spacing:
  sm: 8
  base: 16
  lg: 24
components:
  button-primary:
    type: button
    backgroundColor: '#ff0033'
    textColor: '#ffffff'
    rounded: 24px
    padding: 0 24px
    typography: 16px/700
    use: Primary money action (支払う, チャージ, 送る)
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#ff0033'
    rounded: 24px
    padding: 0 24px
    typography: 16px/700
    use: Secondary action paired with red primary
  button-neutral:
    type: button
    backgroundColor: '#f5f5f5'
    textColor: '#555555'
    rounded: 24px
    padding: 0 24px
    typography: 16px/700
    use: Low-emphasis dismiss (閉じる, 戻る)
  button-text:
    type: button
    backgroundColor: transparent
    textColor: '#ff0033'
    padding: 8px 12px
    typography: 15px/700
    use: Inline tertiary action (もっと見る)
  input-box:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    padding: 14px 16px
    typography: 16px/400
    use: Standard form input
  input-filled:
    type: input
    backgroundColor: '#f5f5f5'
    textColor: '#222222'
    rounded: 8px
    padding: 14px 16px
    typography: 16px/400
    use: Dense forms, search bars
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 16px
    use: Transaction, feature, content cards
  balance-card:
    type: card
    backgroundColor: '#ff0033'
    textColor: '#ffffff'
    rounded: 16px
    padding: 20px
    use: Wallet balance hero, signature surface
  promo-card:
    type: card
    backgroundColor: '#ffebef'
    rounded: 16px
    padding: 20px
    use: Point campaigns, あげる/もらえる offers
  list-item:
    type: listItem
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: 14px 16px
    use: Transaction history, settings rows
  badge-red:
    type: badge
    backgroundColor: '#ff0033'
    textColor: '#ffffff'
    rounded: 10px
    padding: 2px 8px
    typography: 12px/700
    use: NEW, 限定, primary emphasis
  badge-gold:
    type: badge
    backgroundColor: '#ffb200'
    textColor: '#ffffff'
    rounded: 10px
    padding: 2px 8px
    typography: 12px/700
    use: Point amounts, reward emphasis
  badge-green:
    type: badge
    backgroundColor: '#00b900'
    textColor: '#ffffff'
    rounded: 10px
    padding: 2px 8px
    typography: 12px/700
    use: 完了 / success state
  badge-weak:
    type: badge
    backgroundColor: '#ffebef'
    textColor: '#ff0033'
    rounded: 10px
    padding: 2px 8px
    typography: 12px/700
    use: Subtle brand-tinted label
  bottom-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#767676'
    typography: 10px/500
    use: 5-tab bottom nav
    active: '#ff0033 icon + label'
  segmented:
    type: tab
    backgroundColor: '#f5f5f5'
    textColor: '#767676'
    rounded: 10px
    padding: 8px 16px
    typography: 14px/700
    use: In-screen section switching
    active: '#ffffff thumb, #ff0033 text'
  toast:
    type: toast
    backgroundColor: '#222222'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    typography: 14px/500
    use: Transient confirmation (コピーしました)
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 16px
    padding: 24px
    use: Confirmation prompts, alerts
  bottom-sheet:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 20px
    padding: 24px 16px
    use: Selection, picker, payment-method switch
  toggle:
    type: toggle
    backgroundColor: '#ff0033'
    rounded: 9999px
    use: Boolean settings, on=red off=#cccccc
fonts:
  roles:
    sans: Noto Sans JP
    mono: SF Mono
---

# PayPay

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PayPay; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/paypay/DESIGN.md
