---
name: Cathay
colors:
  primary: '#00512a'
  accent: '#26a862'
  accent-tint: '#f3fff7'
  ink-deep: '#00283d'
  canvas: '#fafafa'
  surface: '#ffffff'
  heading: '#333333'
  body: '#555555'
  muted: '#888888'
  hairline: '#eeeeee'
  border-mute: '#bebebe'
  on-primary: '#ffffff'
  warn: '#e87c07'
typography:
  hero:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0px
    use: Homepage hero headline
  section:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0px
    use: Feature / section titles
  subheading:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
    use: Quick-action labels, lead text
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
    use: Standard reading text, nav, button label
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
    use: Footer links, metadata, fine print
rounded:
  sm: 5px
  md: 5px
  lg: 5px
  full: 9999px
spacing:
  xs: 5
  sm: 11
  md: 15
  base: 20
  lg: 27
  xl: 40
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#00512a'
    textColor: '#ffffff'
    border: '1px solid #00512a'
    rounded: 5px
    height: 50px
    padding: 12px 20px
    typography: 16px / 400
    active: fill darkens briefly
    use: Primary CTA (把握好機匯, 我有興趣)
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#00512a'
    border: '1px solid #00512a'
    rounded: 5px
    typography: 16px / 400
    use: Secondary action beside primary CTA
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#333333'
    typography: 16px / 400
    use: Top nav links (個人金融, 企業金融), no underline
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 5px
    padding: 27px
    shadow: rgba(0,0,0,0.12) 0px 4px 16px
    use: Content/product cards (CUBE信用卡)
  card-glass:
    type: card
    backgroundColor: rgba(255,255,255,0.5)
    rounded: 5px
    padding: 40px 15px
    use: Quick-entry glass tiles over hero imagery (開戶, 匯率查詢)
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #eeeeee'
    rounded: 5px
    focus: 'border #00512a'
    use: 'Form input, placeholder #888888'
  footer-link:
    type: tab
    backgroundColor: '#00283d'
    textColor: '#ffffff'
    typography: 14px / 400
    use: Footer group-company + policy links on dark band
fonts:
  roles:
    sans: Roboto Flex
    cjk: Noto Sans TC
    fallback: PingFang TC, Microsoft JhengHei, Heiti TC, sans-serif
---

# Cathay

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cathay; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/cathay/DESIGN.md
