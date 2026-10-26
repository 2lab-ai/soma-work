---
name: EasyWallet
colors:
  primary: '#007bc6'
  primary-hover: '#006ba8'
  brand-teal: '#66ecd2'
  accent-magenta: '#e4007f'
  accent-yellow: '#f6ac19'
  accent-yellow-nav: '#f7b146'
  accent-green: '#40a731'
  canvas: '#ffffff'
  surface: '#efefef'
  body: '#333333'
  text-secondary: '#595153'
  on-primary: '#ffffff'
  placeholder: '#413b3b'
  hairline: '#bfbfbf'
typography:
  hero-xxl:
    fontSize: 234px
    fontWeight: 700
    lineHeight: 1
    use: Oversized brand word BEEP! hero text
  hero-lg:
    fontSize: 58px
    fontWeight: 700
    lineHeight: 1.2
    use: Section H5 main headline
  hero-sub:
    fontSize: 43px
    fontWeight: 700
    lineHeight: 1.2
    use: H4 hero tagline 智慧升級，放心悠遊！
  section-title:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.3
    use: Feature section titles (管理悠遊卡 steps)
  sub-title:
    fontSize: 25px
    fontWeight: 500
    lineHeight: 1.4
    use: H6 sub-headline under section heading
  highlight:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0.17em
    use: Text-highlight box content on brand blue
  nav:
    fontSize: 13.5px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.03em
    use: Navigation menu items
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body text
  caption:
    fontSize: 11px
    fontWeight: 300
    lineHeight: 1
    letterSpacing: 0.1em
    use: Footer legal text / copyright
  download-cta:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.1em
    use: App download CTA button label
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
components:
  button-download:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    typography: 16px / 700 Noto Sans TC
    padding: 20px 32px
    use: App download CTA — App Store / Google Play
  button-blue:
    type: button
    backgroundColor: '#007bc6'
    textColor: '#ffffff'
    rounded: 4px
    typography: 15px / 400 Noto Sans TC
    padding: 8px 25px
    use: Primary action button (藍色按鈕)
  button-outline-blue:
    type: button
    textColor: '#007bc6'
    border: '1px solid #007bc6'
    rounded: 4px
    typography: 15px / 400 Noto Sans TC
    padding: 8px 25px
    use: Secondary outline button
  button-yellow:
    type: button
    backgroundColor: '#f6ac19'
    textColor: '#ffffff'
    rounded: 4px
    typography: 15px / 400 Noto Sans TC
    padding: 8px 25px
    use: Accent yellow CTA
  button-magenta:
    type: button
    backgroundColor: '#e4007f'
    textColor: '#ffffff'
    rounded: 4px
    typography: 15px / 400 Noto Sans TC
    padding: 8px 25px
    use: Accent magenta action
  highlight-block:
    type: card
    backgroundColor: '#007bc6'
    textColor: '#ffffff'
    typography: 20px / 500 Noto Sans TC
    padding: 8px 12px
    use: Inline text-highlight box for body copy emphasis
  card-surface:
    type: card
    backgroundColor: '#efefef'
    textColor: '#333333'
    rounded: 8px
    use: Content section card on light grey surface
  card-white:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 8px
    shadow: rgba(0,0,0,0.15) 0px 10px 20px 0px
    use: Elevated white card for feature content
  nav-item:
    type: tab
    textColor: '#000000'
    typography: 13.5px / 400 Noto Sans TC
    use: Nav menu item
    active: '2px bottom border #f7b146 on hover/active'
  badge-green:
    type: badge
    backgroundColor: '#40a731'
    textColor: '#ffffff'
    rounded: 4px
    typography: 12px / 400 Noto Sans TC
    use: Success or step completion status
  circle-feature:
    type: badge
    backgroundColor: '#e4007f'
    textColor: '#ffffff'
    rounded: 9999px
    use: Circle feature tab indicator (四大優勢 selector)
  input-default:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #bfbfbf'
    rounded: 4px
    typography: 16px / 400 Noto Sans TC
    use: Standard form input
fonts:
  roles:
    display: Noto Sans TC
    body: PingFang TC
    fallback: 微軟正黑體, Microsoft JhengHei, Arial, sans-serif
---

# EasyWallet

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to EasyWallet; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/easywallet/DESIGN.md
