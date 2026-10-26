---
name: Bigin
colors:
  primary: '#006fff'
  link: '#0066cc'
  navy: '#0b1335'
  ink: '#000000'
  heading: '#3d4046'
  body: '#53585f'
  muted: '#7e8696'
  faint: '#b2c0cb'
  canvas: '#ffffff'
  surface-blue: '#f4f9ff'
  surface-tint: '#f1f5fd'
  accent-surface: '#e1f1ff'
  mint: '#dbf4eb'
  mint-border: '#7edbb9'
  hairline: '#e8eaee'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.3
    use: Hero headline on navy band, Spoqa Han Sans Neo Bold
  section:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.4
    use: Section / feature titles
  plan-title:
    fontSize: 32px
    fontWeight: 700
    use: Pricing comparison heading
  subhead:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Feature subheads in slate #3d4046'
  eyebrow:
    fontSize: 20px
    fontWeight: 700
    use: 'Section eyebrow category label in muted #7e8696'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.3
    use: Body copy and inline links
  nav:
    fontSize: 14px
    fontWeight: 700
    use: Nav links and pill button labels
  link-arrow:
    fontSize: 18px
    fontWeight: 500
    use: 'Arrow more-links in #0066cc'
rounded:
  sm: 8px
  md: 20px
  lg: 24px
  xl: 32px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  base: 16
  card: 26
  lg: 40
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#006fff'
    textColor: '#ffffff'
    rounded: 20px
    padding: 10px 15px
    height: 40px
    typography: 14px / 700
    shadow: rgba(0,104,255,0.4) 2px 2px 8px
    use: Header 상담 신청 CTA, electric-blue pill
  button-cta-lift:
    type: button
    backgroundColor: '#006fff'
    textColor: '#ffffff'
    rounded: 24px
    padding: 0 16px
    height: 58px
    typography: 18px / 700
    shadow: rgba(0,104,255,0.4) 0px 4px 16px -4px
    use: Hero / pricing 상담 신청하기 lift CTA
  button-connect:
    type: button
    backgroundColor: '#006fff'
    textColor: '#ffffff'
    rounded: 8px
    height: 36px
    shadow: rgba(0,111,255,0.4) 0px 4px 16px -4px
    use: Inline 연동 connect chip, the one square-ish blue button
  nav-link:
    type: tab
    textColor: '#b2c0cb'
    active: 'text #3d4046'
    typography: 14px / 700
    use: 'Top nav item; muted #7e8696 on inner pages, slate on active'
  feature-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e8eaee'
    rounded: 20px
    padding: 40px
    shadow: rgba(0,0,0,0.04) 0px 5px 51px
    use: Elevated white feature card
  tinted-card:
    type: card
    backgroundColor: '#f4f9ff'
    border: 1px solid rgba(0,0,0,0.05)
    rounded: 20px
    padding: 48px
    use: Light-blue section container
  accent-card:
    type: card
    backgroundColor: '#e1f1ff'
    rounded: 32px
    padding: 28px 57px 48px 77px
    use: Blue accent feature block carrying the new tag
  mint-card:
    type: card
    backgroundColor: '#dbf4eb'
    border: '1px solid #7edbb9'
    rounded: 20px
    use: Mint integration card / callout
  eyebrow-label:
    type: badge
    textColor: '#7e8696'
    typography: 20px / 700
    use: Section eyebrow category label (캠페인, 자동화)
  inline-link:
    type: listItem
    textColor: '#0066cc'
    typography: 16px / 400
    use: Inline body / footer text link
fonts:
  roles:
    display: SpoqaHanSansNeo
    body: SpoqaHanSansNeo
---

# Bigin

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bigin; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/bigin/DESIGN.md
