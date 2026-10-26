---
name: Corca
colors:
  primary: '#1a2352'
  ink-pure: '#000000'
  ink-soft: '#181818'
  accent-blue: '#046cb8'
  bright-blue: '#419eff'
  steel-blue: '#36597d'
  moonlight-cream: '#fff3b7'
  moonlight-deep: '#402060'
  lavender: '#faeeff'
  amber: '#fdd484'
  sky: '#d9e5f5'
  card-violet: '#777cdc'
  card-plum: '#605070'
  body-slate: '#324158'
  muted: '#bbbbbb'
  canvas: '#ffffff'
  surface: '#f1f5f9'
typography:
  display-hero:
    fontSize: 60px
    fontWeight: 400
    use: Hero headline (H1), custom display webfont, white on dark
  section:
    fontSize: 32px
    fontWeight: 400
    use: 'Section headings (H2), navy #1a2352'
  subsection:
    fontSize: 28px
    fontWeight: 400
    use: Feature sub-heads (H2)
  stat:
    fontSize: 46px
    fontWeight: 400
    use: Big metric numbers (100,000+, 1.7M+)
  eyebrow:
    fontSize: 30px
    fontWeight: 400
    use: 'Achievement eyebrow label, blue #046cb8'
  nav:
    fontSize: 17px
    fontWeight: 400
    use: Primary nav item, Madefor/Pretendard
  subnav:
    fontSize: 15px
    fontWeight: 400
    use: Dropdown sub-nav item, Pretendard
  body:
    fontSize: 16px
    fontWeight: 400
    use: Body / UI text, Madefor
rounded:
  sm: 10px
  md: 16px
  lg: 24px
  pill: 50px
  full: 9999px
spacing:
  xs: 8
  sm: 15
  md: 16
  base: 24
  lg: 48
  xl: 64
components:
  button-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a2352'
    rounded: 50px
    padding: 8px 15px
    height: 60px
    typography: 16px / 400
    use: Primary pill CTA (Try it now) — white fill, dark navy label on the dark hero
  button-learn-more:
    type: button
    backgroundColor: '#777cdc'
    textColor: '#ffffff'
    rounded: 50px
    padding: 8px 15px
    height: 51px
    typography: 16px / 400
    use: '''자세히 보기'' section-themed filled pill; fill shifts per product card (also #605070)'
  button-outline:
    type: button
    textColor: '#1a2352'
    border: '1px solid #000000'
    rounded: 999px
    padding: 8px 15px
    height: 38px
    use: '''기사 보기'' outline pill — transparent fill, thin dark ring'
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    use: White product / feature card
  card-surface:
    type: card
    backgroundColor: '#f1f5f9'
    rounded: 10px
    use: Light-grey surface card / panel
  nav-link:
    type: tab
    textColor: '#181818'
    typography: 17px / 400
    use: Top navigation item
    active: 'moonlight cream #fff3b7 text on active product surface'
  badge-eyebrow:
    type: badge
    textColor: '#046cb8'
    rounded: 8px
    use: Achievement eyebrow label (아기유니콘 선정, 세계 7위)
fonts:
  roles:
    display: brand-webfont
    body: Pretendard
    ui: Madefor
---

# Corca

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Corca; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/corca/DESIGN.md
