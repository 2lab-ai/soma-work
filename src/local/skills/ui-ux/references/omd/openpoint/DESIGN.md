---
name: OPENPOINT
colors:
  primary: '#8081ff'
  teal: '#0abbb5'
  lavender: '#cf7ffa'
  lavender-mid: '#a77bca'
  muted-purple: '#9696ad'
  dark-navy: '#48484e'
  error-red: '#e60012'
  canvas: '#ffffff'
  surface: '#f3f3f3'
  surface-light: '#eeeef5'
  surface-lavender: '#f5f2ff'
  on-primary: '#ffffff'
  ink: '#000000'
  placeholder: '#cccccc'
typography:
  h1:
    fontSize: 28.8px
    fontWeight: 700
    lineHeight: 1.5
    use: Page-level heading, OPENPOINT優惠活動
  h2:
    fontSize: 22.4px
    fontWeight: 700
    lineHeight: 1.5
    use: Section headings, OPENPOINT推薦/累積點數
  h3:
    fontSize: 19.2px
    fontWeight: 700
    lineHeight: 1.5
    use: Sub-section headings
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body text, event cards, nav items
  label:
    fontSize: 16px
    fontWeight: 900
    lineHeight: 1
    use: Navigation labels, CTA, event-btn
  small:
    fontSize: 12px
    fontWeight: 400
    use: Metadata, captions
rounded:
  sm: 0px
  md: 8px
  lg: 50px
  full: 9999px
spacing:
  xs: 8
  sm: 16
  md: 24
  base: 16
  lg: 40
  xl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#8081ff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 10px 15px
    typography: 16px / 900 Noto Sans TC
    use: Primary CTA in nav dropdown
  button-cta:
    type: button
    textColor: '#000000'
    rounded: 0px
    padding: 8px 24px
    typography: 16px / 900 微軟正黑體
    use: Event section see-more link
  event-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    shadow: rgba(0, 0, 0, 0.16) 2px 2px 5px 0px
    use: Promotion/event listing card
  card-text:
    type: card
    backgroundColor: '#f3f3f3'
    rounded: 0px
    padding: 16px
    use: Event date+description text area below image
  badge-teal:
    type: badge
    textColor: '#0abbb5'
    rounded: 0px
    typography: 16px / 900 微軟正黑體
    use: Event date labels (.date class)
  nav-link:
    type: tab
    textColor: '#000000'
    typography: 16px / 900 微軟正黑體
    use: Top nav category link
    active: 'text #8081ff underline'
  dropdown-item:
    type: listItem
    textColor: '#ffffff'
    rounded: 8px
    padding: 10px 15px
    typography: 16px / 900 Noto Sans TC
    use: Nav dropdown sub-menu links
  input-default:
    type: input
    textColor: '#000000'
    border: '1px solid #8081ff'
    rounded: 8px
    typography: 16px 微軟正黑體
    use: Member center form fields
    focus: 'border #8081ff'
  gradient-badge:
    type: badge
    backgroundColor: 'linear-gradient(to right, #cf7ffa, #8081ff)'
    textColor: '#ffffff'
    rounded: 0px
    use: Premium/points gradient accent
fonts:
  roles:
    display: Noto Sans TC
    body: 微軟正黑體, 新細明體, 蘋果儷黑體, Arial, Helvetica
---

# OPENPOINT

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to OPENPOINT; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/openpoint/DESIGN.md
