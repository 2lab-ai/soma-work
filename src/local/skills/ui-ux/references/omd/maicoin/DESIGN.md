---
name: MaiCoin / MAX
colors:
  primary: '#ee5457'
  coral-deep: '#dd4c4a'
  coral-red: '#ce4234'
  navy: '#2e4692'
  navy-alt: '#2e4592'
  navy-deep: '#253158'
  accent-blue: '#007aff'
  up-consumer: '#05bb85'
  up-pro: '#49a870'
  down-pro: '#ec5b5c'
  ink: '#262626'
  ink-pure: '#000000'
  body: '#424242'
  muted: '#4d4d4d'
  muted-alt: '#4a4a4a'
  faint: '#9d9d9d'
  input-ink: '#2f333a'
  dark-card: '#272727'
  pill-grey: '#434343'
  canvas: '#ffffff'
  surface: '#f2f4fb'
  surface-alt: '#f4f5f9'
  hairline: '#eaeaea'
  border-navy: '#d5dbee'
  on-primary: '#ffffff'
typography:
  nav:
    fontSize: 14px
    fontWeight: 400
    use: Top nav items, system sans (交易, NFT, 集團)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, system sans
  cta:
    fontSize: 16px
    fontWeight: 600
    use: Consumer coral register CTA label
  cta-pro:
    fontSize: 16px
    fontWeight: 700
    use: MAX navy register CTA label, system sans
  input:
    fontSize: 14px
    fontWeight: 400
    use: MAX form input value + placeholder, system sans
  numeric:
    fontSize: 14px
    fontWeight: 700
    use: MAX price / order-book figures, Iosevka mono
  watermark:
    fontSize: 123px
    fontWeight: 700
    use: Decorative MaiCoin watermark, Roboto, 4% opacity
rounded:
  xs: 2px
  sm: 8px
  md: 12px
  lg: 16px
  pill: 22px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 48
components:
  button-consumer-primary:
    type: button
    backgroundColor: '#ee5457'
    textColor: '#ffffff'
    rounded: 2px
    height: 52px
    typography: 16px / 600
    use: Consumer register CTA (立即註冊) on MaiCoin
  button-pro-primary:
    type: button
    backgroundColor: '#2e4692'
    textColor: '#ffffff'
    rounded: 8px
    height: 60px
    padding: 10px 16px
    typography: 16px / 700
    use: MAX register CTA (立即註冊 / 註冊帳號)
  button-pro-buy:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#2e4592'
    rounded: 22px
    height: 32px
    padding: 0px 12px
    typography: 16px / 400
    use: MAX secondary buy CTA pill (立即購買)
  button-accent:
    type: button
    backgroundColor: '#007aff'
    textColor: '#ffffff'
    rounded: 8px
    height: 40px
    use: MAX promo accent action chip
  promo-card:
    type: card
    backgroundColor: '#272727'
    textColor: '#ffffff'
    rounded: 16px
    padding: 20px
    use: MAX dark promo feature card (鏈上鎖倉, 交易機器人)
  stat-card:
    type: card
    backgroundColor: '#f2f4fb'
    rounded: 12px
    padding: 20px 0px
    use: MAX cool-blue stat strip card
  error-404-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#4a4a4a'
    border: '1px solid #eaeaea'
    rounded: 6px
    height: 88px
    use: MaiCoin 404 action card (查看幣價, 回首頁, 常見問題)
  input-underline:
    type: input
    textColor: '#2f333a'
    typography: 14px / 400
    use: MAX auth field, borderless underline style, placeholder 電子信箱 / 密碼
  nav-link:
    type: tab
    textColor: '#262626'
    typography: 14px / 400
    use: Top nav item
    active: 'coral #ee5457 text on hover/active'
  badge-up:
    type: badge
    backgroundColor: '#49a870'
    textColor: '#ffffff'
    rounded: 8px
    use: MAX price-up / positive change indicator
  badge-down:
    type: badge
    backgroundColor: '#ec5b5c'
    textColor: '#ffffff'
    rounded: 8px
    use: MAX price-down / negative change indicator
  pill-control:
    type: badge
    backgroundColor: '#434343'
    rounded: 20px
    height: 40px
    use: MAX carousel control pill
fonts:
  roles:
    sans: '-apple-system, system-ui, Segoe UI, Roboto'
    mono: Iosevka
    display: Roboto
---

# MaiCoin / MAX

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MaiCoin / MAX; reproduced for educational reference. Full prose: https://oh-my-design.kr/maicoin/design.md
