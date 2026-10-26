---
name: Watcha
colors:
  primary: '#f82f62'
  primary-deep: '#de2a60'
  brand-pink: '#ff0558'
  canvas: '#000000'
  surface-raised-1: '#1a1a1a'
  surface-raised-2: '#28292a'
  surface-hover: '#2c2c2c'
  text-primary: '#ffffff'
  text-secondary: '#999ca1'
  text-tertiary: '#6b6e73'
  success: '#2bc149'
  error: '#f25c5c'
typography:
  hero:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.3
    use: Title-detail hero, billboard
  section:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.35
    use: Row headers
  card:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Poster captions, list titles
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Synopsis, descriptions
  label:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.4
    use: Buttons, chips
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Metadata, fine print
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
components:
  button-primary:
    type: button
    backgroundColor: '#f82f62'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 16px
    typography: 13px/500 Pretendard
    use: 'Login / subscribe CTA, hover #de2a60'
  button-ghost:
    type: button
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 16px
    typography: 13px/500 Pretendard
    use: Secondary, 1px rgba border
  icon-button:
    type: button
    backgroundColor: '#28292a'
    textColor: '#999ca1'
    rounded: 9999px
    use: Close / dismiss circle ~30px
  input-text:
    type: input
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 14px
    typography: 15px/400 Pretendard
    use: 'Login/search, focus border white, error #f25c5c'
  poster-card:
    type: card
    rounded: 4px
    use: Poster image card, no border, hover scale 1.04
  surface-card:
    type: card
    backgroundColor: '#1a1a1a'
    rounded: 8px
    padding: 20px
    use: Settings/account panel
  chip:
    type: badge
    textColor: '#ffffff'
    rounded: 9999px
    padding: 4px 12px
    typography: 12px/500 Pretendard
    use: Genre/tag chip
  snackbar:
    type: toast
    backgroundColor: '#28292a'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    use: Transient feedback, 3s
  modal:
    type: dialog
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 12px
    padding: 24px
    use: Login, plan, rating
  nav-item:
    type: tab
    textColor: '#999ca1'
    typography: 14px/500 Pretendard
    use: Top nav switcher
    active: '#ffffff weight+color shift'
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# Watcha

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Watcha; reproduced for educational reference. Full prose: https://oh-my-design.kr/watcha/design.md
