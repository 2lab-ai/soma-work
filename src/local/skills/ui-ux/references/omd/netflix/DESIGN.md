---
name: Netflix
colors:
  primary: '#E50914'
  primary-hover: '#B20710'
  brand: '#E50914'
  canvas: '#141414'
  foreground: '#FFFFFF'
  muted: '#B3B3B3'
  on-primary: '#FFFFFF'
  surface: '#181818'
  hairline: '#404040'
  body: '#B3B3B3'
  error: '#E87C03'
  success: '#2A9D3C'
  accent-match: '#46D369'
typography:
  billboard-title:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.01px'
    use: Hero artwork title
  display:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.01px'
    use: Marketing hero, sign-up headline
  heading-lg:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.2
    use: Modal title, detail-page show name
  heading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.25
    use: Section / category headers
  row-title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.3
    use: Row headers like Trending Now
  subtitle:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.4
    use: Card title in expanded preview
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Synopsis, descriptions
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard metadata, list rows
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Match %, maturity rating, runtime
  micro:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.02px
    use: Legal, fine print, footer links
rounded:
  sm: 2px
  md: 4px
  lg: 6px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 60
components:
  button-primary:
    type: button
    backgroundColor: '#FFFFFF'
    textColor: '#000000'
    rounded: 4px
    padding: 8px 24px
    typography: 16px / 700
    states: hover rgba(255,255,255,0.75)
    use: Play action on billboard / detail / continue-watching
  button-cta:
    type: button
    backgroundColor: '#E50914'
    textColor: '#FFFFFF'
    rounded: 4px
    padding: 16px 28px
    typography: 18px / 700
    states: 'hover #B20710'
    use: Marketing acquisition CTA (Get Started, Finish Sign-Up)
  button-secondary:
    type: button
    backgroundColor: rgba(109,109,110,0.7)
    textColor: '#FFFFFF'
    rounded: 4px
    padding: 8px 24px
    typography: 16px / 700
    states: hover rgba(109,109,110,0.4)
    use: More Info beside Play
  button-circle:
    type: button
    backgroundColor: rgba(42,42,42,0.6)
    textColor: '#FFFFFF'
    border: 2px solid rgba(255,255,255,0.5)
    rounded: 9999px
    height: 40px
    states: 'hover border #FFFFFF'
    use: Add-to-list, Like, expand on hover cards
  input-auth:
    type: input
    backgroundColor: '#161616'
    textColor: '#FFFFFF'
    border: '1px solid #808080'
    rounded: 4px
    padding: 16px
    typography: 16px / 400
    focus: 'border #FFFFFF'
    states: 'error border-bottom 2px #E87C03'
    use: Email/password on sign-in
  input-search:
    type: input
    backgroundColor: rgba(0,0,0,0.75)
    textColor: '#FFFFFF'
    border: '1px solid #FFFFFF'
    rounded: 4px
    padding: 7px 12px
    typography: 14px / 400
    use: Top-nav search, expands from icon
  card-tile:
    type: card
    backgroundColor: '#181818'
    rounded: 4px
    shadow: none
    use: Resting poster tile in a scrolling row
  card-hover:
    type: card
    backgroundColor: '#181818'
    rounded: 6px
    shadow: 0 12px 24px rgba(0,0,0,0.8)
    states: transform scale(1.5)
    use: Expanded preview card lifting above row
  badge-new:
    type: badge
    backgroundColor: transparent
    textColor: '#E50914'
    typography: 12px / 700
    use: NEW EPISODE / RECENTLY ADDED overlay, uppercase
  badge-top10:
    type: badge
    backgroundColor: '#E50914'
    textColor: '#FFFFFF'
    typography: 9px / 700
    use: Top 10 trending-rank ribbon
  badge-maturity:
    type: badge
    backgroundColor: rgba(51,51,51,0.6)
    textColor: '#FFFFFF'
    border: '1px solid #666666'
    rounded: 2px
    padding: 2px 6px
    typography: 13px / 400
    use: Maturity rating on detail pages / previews
  tab-nav:
    type: tab
    textColor: '#E5E5E5'
    typography: 14px / 400
    active: 'color #FFFFFF weight 700'
    states: 'hover #B3B3B3'
    use: Top nav links
  toast-banner:
    type: toast
    backgroundColor: '#E87C03'
    textColor: '#FFFFFF'
    padding: 12px 16px
    typography: 14px / 500
    use: Account / payment full-width top banner
  dialog-modal:
    type: dialog
    backgroundColor: '#181818'
    textColor: '#FFFFFF'
    rounded: 6px
    padding: 0 / 24px body
    shadow: 0 8px 32px rgba(0,0,0,0.9)
    use: Title-detail modal, account-action confirm
  toggle-default:
    type: toggle
    backgroundColor: '#737373'
    rounded: 9999px
    states: 'on track #E50914, thumb #FFFFFF'
    use: Autoplay previews, subtitle, profile-lock switches
fonts:
  roles:
    sans: Netflix Sans
    mono: Courier New
---

# Netflix

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Netflix; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/netflix/DESIGN.md
