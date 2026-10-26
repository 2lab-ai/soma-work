---
name: 17LIVE
colors:
  primary: '#FF4F6E'
  primary-hover: '#E8455F'
  canvas: '#121212'
  surface-1: '#1C1C1E'
  surface-2: '#2C2C2E'
  foreground: '#FFFFFF'
  on-primary: '#FFFFFF'
  rank-gold: '#FFC83D'
  vip-purple: '#8B5CF6'
  success: '#27C76F'
  warning: '#F5A623'
  error: '#FF453A'
typography:
  micro:
    fontSize: 11px
    fontWeight: 700
    use: Viewer count, LIVE badge, gamified numbers
  caption:
    fontSize: 12px
    fontWeight: 400
    use: Chat meta, captions, metadata
  body:
    fontSize: 14px
    fontWeight: 400
    use: Chat message, body text
  liver-name:
    fontSize: 16px
    fontWeight: 700
    use: LIVER name, list title, key labels
  section:
    fontSize: 20px
    fontWeight: 600
    use: Section heading, tab labels
  hero:
    fontSize: 28px
    fontWeight: 700
    use: Hero / spotlight headline
rounded:
  sm: 4px
  md: 12px
  lg: 24px
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
    backgroundColor: '#FF4F6E'
    textColor: '#FFFFFF'
    rounded: 24px
    padding: 12px 24px
    typography: 16px / 700
    states: 'pressed #E8455F'
    use: GO LIVE, primary CTAs, sign-up
  button-follow:
    type: button
    backgroundColor: '#FF4F6E'
    textColor: '#FFFFFF'
    rounded: 16px
    padding: 6px 16px
    typography: 14px / 600
    states: following → transparent + 1px rgba(255,255,255,0.3), fg rgba(255,255,255,0.7)
    use: Follow / Following toggle
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#FFFFFF'
    border: 1px solid rgba(255,255,255,0.3)
    rounded: 24px
    padding: 12px 24px
    typography: 16px / 600
    use: Secondary actions, Maybe later
  button-gift:
    type: button
    backgroundColor: '#FF4F6E → #FF2D8E gradient'
    textColor: '#FFFFFF'
    rounded: 20px
    use: Send-gift — highest-energy transaction
  input:
    type: input
    backgroundColor: '#2C2C2E'
    textColor: '#FFFFFF'
    rounded: 12px
    padding: 12px 16px
    focus: '1px solid #FF4F6E'
    use: Search, login, profile; placeholder rgba(255,255,255,0.45)
  chat-input:
    type: input
    backgroundColor: '#2C2C2E'
    rounded: 24px
    use: 'Live-chat composer overlay, trailing pink #FF4F6E send icon'
  stream-card:
    type: card
    rounded: 12px
    use: Discover grid — thumbnail + rgba(0,0,0,0.5) bottom gradient, LIVE badge + viewer count + LIVER name
  card:
    type: card
    backgroundColor: '#1C1C1E'
    rounded: 12px
    padding: 12px
    use: LIVER lists, ranking rows, fan-club cards
  badge-live:
    type: badge
    backgroundColor: '#FF4F6E'
    textColor: '#FFFFFF'
    rounded: 4px
    padding: 2px 6px
    typography: 11px / 700
    use: 'Live-now indicator (or #27C76F dot)'
  badge-rank:
    type: badge
    backgroundColor: '#FFC83D'
    textColor: '#121212'
    rounded: 50%
    use: 'Leaderboard / top-fan #1 status'
  avatar:
    type: avatar
    rounded: 50%
    use: LIVER and viewer avatars, optional pink/gradient ring for live or VIP
  tab-bar:
    type: tab
    use: Bottom tab bar; center GO LIVE elevated pink
    active: '#FF4F6E label'
    states: inactive rgba(255,255,255,0.45)
fonts:
  roles:
    default: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    tc: '"PingFang TC", "Microsoft JhengHei", sans-serif'
    jp: '"Hiragino Kaku Gothic Pro", "Meiryo", sans-serif'
    sc: '"PingFang SC", "Microsoft YaHei", sans-serif'
---

# 17LIVE

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 17LIVE; reproduced for educational reference. Full prose: https://oh-my-design.kr/17live/design.md
