---
name: Fubon
colors:
  primary: '#0093c1'
  primary-group: '#008fc7'
  primary-hover: '#005c7a'
  teal-accent: '#00a59b'
  sky-light: '#3cbeE7'
  canvas: '#ffffff'
  surface: '#f5f5f5'
  surface-subtle: '#f3fbfe'
  ink: '#0c0e1f'
  body: '#494a57'
  muted: '#7d7f87'
  hairline: '#d7d6db'
  on-primary: '#ffffff'
  error: '#d32f2f'
  success: '#00a59b'
typography:
  h1:
    fontSize: 25px
    fontWeight: 400
    lineHeight: 1.4
    use: Page-level heading (personal / section)
  h2-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Section title (.title-primary)
  h2-small:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: Compact section title
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body text
  nav:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.4
    use: Top nav links
  cta-link:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.4
    use: More-link CTAs (了解更多 / 更多最新公告)
  label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Sub-nav, footer links, captions
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.25
    use: Popup confirm / cancel button
rounded:
  sm: 4px
  md: 12px
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
components:
  button-primary:
    type: button
    backgroundColor: '#0093c1'
    textColor: '#ffffff'
    rounded: 12px
    typography: 16px / 700 Roboto
    border: '1px solid #0093c1'
    use: Primary confirm / CTA (確認, 同意)
  button-secondary:
    type: button
    backgroundColor: '#eef0f0'
    textColor: '#0c0e1f'
    rounded: 12px
    typography: 16px / 700 Roboto
    border: '1px solid #eef0f0'
    use: Cancel / secondary action (取消)
  button-cta-lg:
    type: button
    backgroundColor: '#008fc7'
    textColor: '#ffffff'
    rounded: 0px
    typography: 16px / 400 Roboto
    use: Group-level large CTA (了解更多, 60px height)
  nav-link:
    type: tab
    textColor: '#0c0e1f'
    typography: 18px / 400 Roboto
    use: Personal banking top nav link
    active: 'text #0093c1 underline on hover'
  card-white:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#0c0e1f'
    rounded: 0px
    shadow: rgba(0,0,0,0.11) 5px 5px 30px
    use: White content card with drop shadow
  card-surface:
    type: card
    backgroundColor: '#f5f5f5'
    textColor: '#0c0e1f'
    use: Light grey tinted surface card
  card-sky:
    type: card
    backgroundColor: '#f3fbfe'
    textColor: '#0c0e1f'
    use: Sky-blue tinted info card
  badge-blue:
    type: badge
    backgroundColor: '#0093c1'
    textColor: '#ffffff'
    rounded: 4px
    use: Category / service badge
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0c0e1f'
    border: '1px solid #d7d6db'
    rounded: 0px
    typography: 14px / 400 Roboto
    use: Standard form input field
  badge-teal:
    type: badge
    backgroundColor: '#00a59b'
    textColor: '#ffffff'
    rounded: 4px
    use: Success / eco / sustainable action badge
fonts:
  roles:
    sans: Roboto
    tc: Noto Sans TC
    fallback: Microsoft JhengHei
---

# Fubon

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Fubon; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/fubon/DESIGN.md
