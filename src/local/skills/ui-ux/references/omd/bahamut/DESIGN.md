---
name: Bahamut
colors:
  primary: '#11aac1'
  primary-dark: '#117e96'
  primary-deeper: '#009cad'
  canvas: '#ffffff'
  page-bg: '#f8f8f8'
  surface: '#f3f3f3'
  heading: '#2d2d2d'
  body: '#464646'
  muted: '#8c8c8c'
  on-primary: '#ffffff'
  red-accent: '#e60012'
  hairline: '#e5e7eb'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text and nav links
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Sidebar links, tab labels, metadata
  body-xs:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Supplementary labels, timestamps
  heading:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.4
    use: Section headings
  active-nav:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.57
    use: Active navigation tab (bold + teal)
rounded:
  sm: 2px
  md: 4px
  lg: 8px
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
  nav-tab-active:
    type: tab
    backgroundColor: '#11aac1'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 12px
    typography: 14px / 700
    active: 'bg #11aac1 text #ffffff'
    use: Active section tab in top nav (首頁, GNN新聞)
  nav-tab-inactive:
    type: tab
    textColor: '#464646'
    rounded: 4px
    padding: 8px 12px
    typography: 14px / 400
    use: Inactive nav tab
  nav-link-active:
    type: listItem
    textColor: '#117e96'
    typography: 14px / 700
    use: Active sidenav link with teal tint bg
  search-input:
    type: input
    backgroundColor: '#ffffff'
    border: 0px none
    rounded: 0px
    typography: 14px / 400
    use: Search bar embedded in nav header
  content-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    use: Article and game content card, shadow 0 1px 3px rgba(0,0,0,0.08)
  post-badge:
    type: badge
    backgroundColor: '#e60012'
    textColor: '#ffffff'
    rounded: 2px
    typography: 12px / 400
    use: Hot/new post indicator tag
  section-tag:
    type: badge
    backgroundColor: '#f3f3f3'
    textColor: '#464646'
    rounded: 4px
    padding: 4px 8px
    typography: 12px / 400
    use: Category tags in listing pages
  register-btn:
    type: button
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px 10px
    typography: 16px / 400
    use: Register / Login header links on dark nav
fonts:
  roles:
    sans: '"Helvetica Neue", Helvetica, Roboto, Arial, "Lucida Grande", "PingFang TC", sans-serif'
---

# Bahamut

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bahamut; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/bahamut/DESIGN.md
