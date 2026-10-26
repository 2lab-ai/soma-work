---
name: komoot
colors:
  primary: '#4f6814'
  primary-hover: '#404823'
  green-deep: '#212512'
  accent: '#ee6b17'
  accent-hover: '#ca5910'
  accent-subtle: '#fce1d1'
  secondary: '#e3d2b4'
  secondary-hover: '#d0c1a6'
  subtle-green: '#e7e8d1'
  purple: '#8879e1'
  foreground: '#1c1a18'
  text-on-primary: '#f5f3ec'
  background: '#faf9f4'
  sand: '#ede9de'
  border: '#edebe5'
  border-idle: '#e0dbce'
  disabled: '#d1cdc4'
  danger: '#b53521'
typography:
  display:
    fontSize: 72px
    fontWeight: 500
    use: hero heading; H2 40px/500
  button:
    fontSize: 14px
    fontWeight: 700
    use: header buttons
rounded:
  md: 12px
  lg: 16px
components:
  button-primary:
    type: button
    backgroundColor: '#4f6814'
    textColor: '#f5f3ec'
    rounded: 16px
    height: 43px
    padding: 12px 16px
    typography: 14px / 700
    hover: '#404823'
    pressed: '#404823'
    use: 'Login or Signup — olive primary (actionBaseFillPrimary) darkening to #404823.'
    focus: 'bg #404823, shadow rgba(66, 153, 225, 0.5) 0px 0px 0px 3px, outline #1c1a18 solid 4px on :focus-visible'
  nav-ghost-white:
    type: button
    backgroundColor: transparent
    textColor: '#faf9f4'
    rounded: 12px
    height: 35px
    padding: 8px 12px
    typography: 14px / 500
    hover: rgba(28,26,24,0.498)
    pressed: rgba(28,26,24,0.498)
    use: 'Routes / Planner / Features / Updates over the hero — off-white text; hover lays a 50% ink fill (actionBaseFillGhostWhiteHover #1c1a187f).'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Nohemi
    sans: Satoshi
---

# komoot

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to komoot; reproduced for educational reference. Full prose: https://oh-my-design.kr/komoot/design.md
