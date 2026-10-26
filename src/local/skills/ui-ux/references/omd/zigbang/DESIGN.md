---
name: Zigbang
colors:
  primary: '#0066ff'
  brand-orange: '#ff6600'
  canvas: '#ffffff'
  heading: '#171719'
  bookmark: '#333333'
  on-primary: '#ffffff'
typography:
  base:
    fontSize: 16px
    fontWeight: 400
    use: Browser default body text
  nav:
    fontSize: 14px
    fontWeight: 400
    use: Nav button label
  search-icon:
    fontSize: 24px
    fontWeight: 400
    use: Icon-only search glyph
  station:
    fontSize: 22px
    fontWeight: 400
    use: Station / region chip — read at distance
  paginator:
    fontSize: 20px
    fontWeight: 400
    use: Paginator arrows, disabled by default
  heading:
    fontSize: 13px
    fontWeight: 700
    use: Chrome heading — smaller than body, weight marks structure
rounded:
  sm: 8px
  md: 10px
  lg: 10px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  nav-auth-link:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0066ff'
    rounded: 8px
    padding: 7px 14px
    typography: 14/400
    use: 회원가입/로그인 auth entry
  nav-link:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171719'
    rounded: 8px
    padding: 7px 14px
    typography: 14/400
    use: Standard top-bar nav links
  search-trigger:
    type: button
    textColor: '#171719'
    rounded: 9999px
    typography: 24/400
    use: Icon-only search button, circular hit area
  station-chip:
    type: badge
    textColor: '#171719'
    rounded: 10px
    padding: 7px 9px 7px 11px
    typography: 22/400
    use: Subway-station / region map label
  bookmark-toggle:
    type: toggle
    textColor: '#333333'
    rounded: 9999px
    padding: 8px
    use: Save-this-listing toggle, glyph-only
  paginator:
    type: tab
    textColor: '#333333'
    rounded: 10px
    padding: 8px
    typography: 20/400
    use: Paired prev/next, split-corner segmented control
  listing-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    use: White card on white map canvas, 1px hairline separation
  price-chip:
    type: badge
    textColor: '#171719'
    rounded: 10px
    typography: 22/400
    use: Listing price — color-separated active/past/highlight
fonts:
  roles:
    sans: Pretendard Variable
    mono: Pretendard Variable
---

# Zigbang

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Zigbang; reproduced for educational reference. Full prose: https://oh-my-design.kr/zigbang/design.md
