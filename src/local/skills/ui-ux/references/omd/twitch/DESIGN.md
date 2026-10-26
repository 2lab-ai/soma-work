---
name: Twitch
colors:
  primary: '#9146ff'
  link: '#5c16c5'
  primary-hover: '#451093'
  primary-deep: '#330c6e'
  ink: '#0e0e10'
  body: '#3b3b44'
  muted: '#747484'
  canvas: '#f7f7f8'
  surface-alt: '#efeff1'
  on-primary: '#ffffff'
  live: '#eb0400'
  info: '#1f69ff'
typography:
  display-hero:
    fontSize: 31px
    fontWeight: 600
    lineHeight: 1.1
    use: Brand hero headline, Roobert TW
  section:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.2
    use: Brand section links, Roobert TW
  heading:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.3
    use: Core UI carousel / shelf titles, Roobert
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Standard reading + UI text, Inter
  button:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    use: Button labels, Inter SemiBold
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.2
    use: LIVE badge, viewer counts, metadata
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  full: 9000px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 18
  xl: 24
  xxl: 40
components:
  button-primary:
    type: button
    backgroundColor: '#9146ff'
    textColor: '#ffffff'
    rounded: 9000px
    height: 32px
    typography: 14px / 600 Inter
    use: Sign Up CTA / brand Download — full pill, Ultraviolet
  button-secondary:
    type: button
    textColor: '#0e0e10'
    rounded: 9000px
    height: 32px
    typography: 14px / 600 Inter
    use: Log In — translucent rgba(173,173,184,0.22) fill pill
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0e0e10'
    rounded: 8px
    height: 36px
    padding: 0px 12px
    typography: 14px / 400 Inter
    use: Top search field, inset rgba(50,50,57,0.62) 1px ring
  nav-link:
    type: tab
    textColor: '#0e0e10'
    typography: 14px / 400 Inter
    active: 'text #5c16c5'
    use: Top + side nav item, active = deep violet
  card-channel:
    type: card
    backgroundColor: '#f7f7f8'
    rounded: 4px
    use: Live channel tile on canvas, thumbnail-led, no shadow
  badge-live:
    type: badge
    backgroundColor: '#eb0400'
    textColor: '#ffffff'
    rounded: 4px
    padding: 1px 5px
    typography: 12px / 400 Inter
    use: LIVE status indicator on thumbnails
  badge-viewers:
    type: badge
    textColor: '#ffffff'
    rounded: 2px
    padding: 0px 4px
    typography: 14px / 400 Inter
    use: Viewer-count overlay — rgba(0,0,0,0.6) scrim pill
  avatar:
    type: avatar
    rounded: 9000px
    use: Channel / user avatar — full circle
fonts:
  roles:
    display: Roobert
    body: Inter
---

# Twitch

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Twitch; reproduced for educational reference. Full prose: https://oh-my-design.kr/twitch/design.md
