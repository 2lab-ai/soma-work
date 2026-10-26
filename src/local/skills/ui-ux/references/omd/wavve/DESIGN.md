---
name: Wavve
colors:
  primary: '#1351f9'
  primary-bright: '#3a6cff'
  primary-deep: '#0e3fcc'
  canvas: '#0a0e1a'
  surface-raised-1: '#141a2b'
  surface-raised-2: '#1f2742'
  text-primary: '#ffffff'
  text-secondary: '#a7aec0'
  text-tertiary: '#6b7286'
  live: '#f5444c'
  success: '#2bc56f'
  error: '#ff7a45'
typography:
  billboard:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    use: Hero/billboard title
  section:
    fontSize: 20px
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
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.4
    use: Play/subscribe, tabs
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Metadata, runtime
  live:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.4
    use: LIVE / 실시간 indicators
rounded:
  sm: 4px
  md: 6px
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
    backgroundColor: '#1351f9'
    textColor: '#ffffff'
    rounded: 6px
    padding: 10px 20px
    typography: 15px/600 Pretendard
    use: 'Play/subscribe, hover #3a6cff, pressed #0e3fcc'
  button-ghost:
    type: button
    textColor: '#ffffff'
    rounded: 6px
    padding: 10px 20px
    typography: 15px/600 Pretendard
    use: Secondary on dark, 1px rgba border
  icon-button:
    type: button
    textColor: '#ffffff'
    rounded: 9999px
    use: Carousel/player controls ~40px
  input-text:
    type: input
    textColor: '#ffffff'
    rounded: 6px
    padding: 12px 14px
    typography: 15px/400 Pretendard
    use: 'Login/search, focus border #1351f9, error #ff7a45'
  poster-card:
    type: card
    rounded: 6px
    use: Poster image card, no border, hover scale 1.05
  surface-card:
    type: card
    backgroundColor: '#141a2b'
    rounded: 10px
    padding: 20px
    use: Settings/account panel
  chip:
    type: badge
    textColor: '#ffffff'
    rounded: 9999px
    padding: 4px 12px
    typography: 12px/500 Pretendard
    use: 'Genre/tag, active #1351f9 bg'
  live-badge:
    type: badge
    backgroundColor: '#f5444c'
    textColor: '#ffffff'
    rounded: 4px
    padding: 1px 6px
    typography: 11px/700 Pretendard
    use: 실시간 TV indicator
  snackbar:
    type: toast
    backgroundColor: '#1f2742'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    typography: 14px/500 Pretendard
    use: Transient feedback, 3s
  modal:
    type: dialog
    backgroundColor: '#141a2b'
    textColor: '#ffffff'
    rounded: 12px
    padding: 24px
    use: Login, plan selection
  nav-item:
    type: tab
    textColor: '#a7aec0'
    typography: 15px/500 Pretendard
    use: Top nav switcher
    active: '#ffffff with 2px #1351f9 underline'
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# Wavve

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Wavve; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/wavve/DESIGN.md
