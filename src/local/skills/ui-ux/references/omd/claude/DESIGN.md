---
name: Claude (Anthropic)
colors:
  primary: '#c96442'
  canvas: '#f5f4ed'
  surface: '#ffffff'
  foreground: '#141413'
  muted: '#5e5d59'
  surface-dark: '#30302e'
  hairline: '#f0eee6'
  warm-sand: '#e8e6dc'
typography:
  display:
    fontSize: 64px
    fontWeight: 500
    lineHeight: 1.1
    use: Observed Claude public-route h1
  heading:
    fontSize: 52px
    fontWeight: 500
    lineHeight: 1.2
    use: Observed Claude public-route h2
  body:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    use: Repeated public-route body and list text
  control:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    use: Observed public-route button and input text
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  card: 24px
  media: 32px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 24
  xxl: 32
  3xl: 48
components:
  overview-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#141413'
    rounded: 12px
    padding: 8px 16px 8px 12px
    typography: 20px/400 Anthropic Sans
    states: selected, hover, and pressed observed on the public overview tabs
    use: Selected tab on the public Claude overview
  model-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #f0eee6'
    rounded: 32px
    padding: 48px
    use: Public Claude overview model card
  pricing-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #f0eee6'
    rounded: 24px
    padding: 32px
    use: Public Claude pricing card
fonts:
  roles:
    ui: Anthropic Sans
    display: Anthropic Serif
---

# Claude (Anthropic)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Claude (Anthropic); reproduced for educational reference. Full prose: https://oh-my-design.kr/claude/design.md
