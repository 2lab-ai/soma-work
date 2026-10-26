---
name: Xiaohongshu
colors:
  primary: '#ff2442'
  red-pressed: '#e01f3d'
  red-tint: '#ffecef'
  canvas: '#ffffff'
  surface: '#f5f5f5'
  text-primary: '#333333'
  text-secondary: '#999999'
  text-tertiary: '#cccccc'
  border: '#eeeeee'
  divider: '#f0f0f0'
  error: '#ff4d4f'
  success: '#52c41a'
typography:
  header:
    fontSize: 18px
    fontWeight: 600
    use: Profile names, section titles
  note-title:
    fontSize: 14px
    fontWeight: 500
    use: Note title, two-line clamp
  body:
    fontSize: 15px
    fontWeight: 400
    use: Note detail reading view
  meta:
    fontSize: 12px
    fontWeight: 400
    use: Username, likes, timestamp
  caption:
    fontSize: 11px
    fontWeight: 400
    use: Hashtags, fine labels
rounded:
  sm: 8px
  md: 16px
  lg: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
components:
  button-primary:
    type: button
    backgroundColor: '#ff2442'
    textColor: '#ffffff'
    rounded: 20px
    padding: 6px 16px
    typography: 14px/500 PingFang SC
    use: 'Follow / buy CTA, press #e01f3d'
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 20px
    padding: 6px 16px
    typography: 14px/500 PingFang SC
    use: 'Following state, 1px #eeeeee border'
  input-search:
    type: input
    backgroundColor: '#f5f5f5'
    textColor: '#333333'
    rounded: 20px
    padding: 8px 16px
    typography: 14px/400 PingFang SC
    use: Pill search, red caret
  note-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 8px 10px
    use: Waterfall note card, variable height, no border
  chip:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#333333'
    rounded: 16px
    padding: 4px 12px
    typography: 12px/400 PingFang SC
    use: 'Hashtag chip, branded uses #ffecef bg #ff2442 text'
  like-heart:
    type: toggle
    textColor: '#999999'
    use: 'Outline heart, active fill #ff2442 with scale-pop'
  action-sheet:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 16px
    use: Bottom sheet, 40% black backdrop
  nav-tab:
    type: tab
    textColor: '#999999'
    use: Top/category tab
    active: '#ff2442 text + red underline'
fonts:
  roles:
    sans: PingFang SC
    mono: PingFang SC
---

# Xiaohongshu

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Xiaohongshu; reproduced for educational reference. Full prose: https://oh-my-design.kr/xiaohongshu/design.md
