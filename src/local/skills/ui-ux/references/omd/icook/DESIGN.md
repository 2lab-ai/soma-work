---
name: iCook
colors:
  primary: '#f04646'
  primary-light: '#ff6060'
  accent-warm: '#f06354'
  amber: '#f0993c'
  ink: '#564e4a'
  muted: '#89817d'
  muted-light: '#706860'
  faint: '#a39b97'
  canvas: '#ffffff'
  surface: '#fbfaf8'
  surface-warm: '#efeee8'
  surface-mid: '#f0f0f0'
  hairline: '#e0d9d5'
  on-primary: '#ffffff'
typography:
  hero:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.4
    use: Page title (H1), e.g. 人氣食譜
  section:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.4
    use: Section headers (H3) on homepage
  card-heading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: Recipe card title (H2) in browse lists
  feature-title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.4
    use: Feature card title / event card heading
  nav:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    use: Primary category nav tabs
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.15
    use: Default reading text, nav links, metadata
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Badge labels, small metadata
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    use: Download CTA label
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 15
  lg: 24
  xl: 32
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#f04646'
    textColor: '#ffffff'
    rounded: 4px
    padding: 1px 6px
    typography: 14px / 500
    height: 32px
    use: App download CTA in nav
  button-app-open:
    type: button
    backgroundColor: '#f04646'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 16px
    typography: 14px / 500
    use: Open in iCook App CTA on recipe page
  button-ghost:
    type: button
    textColor: '#f06354'
    border: '1px solid #f06354'
    rounded: 50%
    padding: 8px
    use: Carousel prev/next circular icon button
  button-more:
    type: button
    textColor: '#f06354'
    rounded: 0px
    padding: 1px 6px
    typography: 16px / 400
    use: Section more-link text button
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#564e4a'
    border: none
    rounded: 0px
    padding: 0px 15px
    height: 44px
    typography: 14px / 400
    use: Global search bar (recipe keyword input)
  recipe-card:
    type: card
    backgroundColor: '#f0f0f0'
    textColor: '#564e4a'
    rounded: 16px
    shadow: none
    use: Homepage story cards with photo
  event-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#564e4a'
    rounded: 4px
    shadow: none
    use: Activity/event card with image
  category-chip:
    type: badge
    textColor: '#f06354'
    border: '1px solid #f06354'
    rounded: 4px
    use: Browse category category with image overlay
  badge-amber:
    type: badge
    backgroundColor: '#f0993c'
    textColor: '#ffffff'
    rounded: 4px
    use: Seasonal / special label badge
  nav-tab:
    type: tab
    textColor: '#564e4a'
    typography: 16px / 700
    padding: 0px 16px
    height: 40px
    active: 'border-bottom #f04646 2px + text #f04646'
    use: 'Category tabs: 最新食譜 / 人氣食譜 / 低卡瘦身'
fonts:
  roles:
    display: system-ui, -apple-system, PingFang TC, Microsoft JhengHei
    body: system-ui, -apple-system, PingFang TC, Microsoft JhengHei
---

# iCook

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to iCook; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/icook/DESIGN.md
