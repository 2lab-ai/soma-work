---
name: Taiwan Mobile
colors:
  primary: '#ff6700'
  primary-hover: '#f45100'
  primary-alt: '#ff8f08'
  brand-indigo: '#2d2d6c'
  teal-accent: '#024d58'
  ink: '#2d3033'
  secondary: '#515a68'
  muted: '#838d9c'
  canvas: '#ffffff'
  surface: '#f5f7f8'
  card-bg: '#e3e7ee'
  dark-bar: '#1e2022'
  on-primary: '#ffffff'
  green-accent: '#0eaa7d'
  pink-accent: '#ce2874'
typography:
  hero:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.25
    use: Hero banner headline (carousel)
  section:
    fontSize: 34px
    fontWeight: 500
    lineHeight: 1.35
    use: Section headings (plan finder, features)
  nav:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Top navigation links
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body text, Noto Sans TC
  label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: UI labels, button text
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Metadata, fine print
rounded:
  sm: 8px
  md: 20px
  lg: 40px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 40
  xxl: 60
  section: 80
  hero: 120
components:
  button-primary:
    type: button
    backgroundColor: '#ff6700'
    textColor: '#ffffff'
    rounded: 40px
    height: 45px
    padding: 8px 24px
    typography: 18px / 400 Poppins
    states: 'hover #f45100'
    use: Primary plan CTA — '搭手機', '搭光纖'
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#838d9c'
    rounded: 40px
    height: 45px
    padding: 8px 24px
    typography: 18px / 400 Poppins
    use: Inactive plan tab (搭商品 / 搭光纖 / 單門號)
  button-login:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 50px
    height: 37px
    padding: 12px 16px
    typography: 14px / 400 Poppins
    use: Login pill in dark nav band
  button-white:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#515a68'
    rounded: 40px
    height: 44px
    padding: 0 16px
    typography: 15px / 400 Poppins
    use: Dialog dismiss / secondary action '我知道了'
  card-picture:
    type: card
    backgroundColor: '#e3e7ee'
    rounded: 20px
    use: Picture product card, 280×280–520×520px, no shadow
  card-surface:
    type: card
    backgroundColor: '#f5f7f8'
    rounded: 20px
    use: Content card on default surface
  badge-orange:
    type: badge
    backgroundColor: '#ff6700'
    textColor: '#ffffff'
    rounded: 9999px
    typography: 12px / 400 Poppins
    use: Promotional / highlight tag
  nav-tab:
    type: tab
    textColor: '#ffffff'
    typography: 15px / 400 Poppins
    use: Top nav category (個人/家庭/企業)
    active: 'text #ff6700 on active highlight'
  dialog-cookie:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 20px
    shadow: 0 2px 8px rgba(0,0,0,0.08)
    use: Cookie notice / info overlay
fonts:
  roles:
    display: Poppins
    body: Noto Sans TC
    fallback: system-ui, -apple-system, Segoe UI, Roboto
---

# Taiwan Mobile

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Taiwan Mobile; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/taiwanmobile/DESIGN.md
