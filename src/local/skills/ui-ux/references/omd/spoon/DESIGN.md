---
name: Spoon
colors:
  primary: '#FF5500'
  primary-hover: '#E64D00'
  brand: '#FF5500'
  canvas: '#FFFFFF'
  foreground: '#1A1A1A'
  body: '#333333'
  muted: '#767676'
  on-primary: '#FFFFFF'
  surface: '#F2F2F2'
  hairline: '#E5E5E5'
  success: '#22C55E'
  error: '#FF3B30'
  accent-gift: '#FFB300'
  accent-coral: '#F23C5C'
typography:
  hero:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.3
    use: Marketing hero, section headlines
  section:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.35
    use: 라이브/팟캐스트/랭킹 headers
  card-title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Live-room titles, DJ names
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Descriptions, room info
  chip:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Hashtag chips, CTAs
  meta:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Listener counts, timestamps
  caption:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    use: Fine print
rounded:
  sm: 6px
  md: 12px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
components:
  button-primary:
    type: button
    backgroundColor: '#FF5500'
    textColor: '#FFFFFF'
    rounded: 999px
    height: 28px
    padding: 4px 12px
    typography: 12px / 500
    hover: '#E64D00'
    use: Login/signup primary CTA — compact orange pill
    pressed: '#e84d00'
  button-golive:
    type: button
    backgroundColor: '#FF5500'
    textColor: '#FFFFFF'
    rounded: 999px
    padding: 10px 20px
    typography: 15px / 600
    use: 방송하기 / start-a-live — larger orange pill
  button-outline:
    type: button
    backgroundColor: '#FFFFFF'
    textColor: '#FF5500'
    border: '1px solid #FF5500'
    rounded: 999px
    padding: 4px 12px
    typography: 12px / 500
    use: Follow, secondary action
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    typography: 14px / 500
    use: Tertiary nav, 더보기
  input:
    type: input
    backgroundColor: '#F2F2F2'
    textColor: '#1A1A1A'
    rounded: 999px
    padding: 8px 14px
    typography: 14px / 400
    focus: 'border #FF5500'
    use: 'Room/DJ search, form fields; placeholder #AAAAAA'
  card:
    type: card
    backgroundColor: '#FFFFFF'
    border: '1px solid #E5E5E5'
    rounded: 12px
    padding: 12px
    use: Live-room card — avatar, title, hashtags, listener count
  avatar:
    type: avatar
    backgroundColor: '#D9D9D9'
    border: '2px solid #FF5500'
    rounded: 50%
    use: DJ/creator avatar; orange ring = live now
  chip-hashtag:
    type: badge
    backgroundColor: '#F2F2F2'
    textColor: '#333333'
    rounded: 12px
    padding: 0 6px
    typography: 12px / 400
    use: Discovery hashtag chip
  badge-live:
    type: badge
    backgroundColor: '#FF5500'
    textColor: '#FFFFFF'
    rounded: 6px
    padding: 2px 6px
    typography: 11px / 600
    use: LIVE / ON AIR flag
  badge-gift:
    type: badge
    backgroundColor: rgba(255,179,0,0.15)
    textColor: '#FFB300'
    rounded: 999px
    padding: 2px 8px
    typography: 12px / 600
    use: Spoon-count / gift indicator
  tab:
    type: tab
    textColor: '#767676'
    active: 'text #1A1A1A weight 600, #FF5500 on selected'
    typography: 14px / 500
    use: 라이브/팟캐스트/랭킹 switcher
  toast:
    type: toast
    backgroundColor: '#1A1A1A'
    textColor: '#FFFFFF'
    rounded: 12px
    padding: 12px 16px
    use: Transient feedback snackbar
  dialog:
    type: dialog
    backgroundColor: '#FFFFFF'
    textColor: '#1A1A1A'
    rounded: 16px
    padding: 24px
    shadow: rgba(0,0,0,0.5)
    use: Login, gift selection, bottom sheet
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# Spoon

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Spoon; reproduced for educational reference. Full prose: https://oh-my-design.kr/spoon/design.md
