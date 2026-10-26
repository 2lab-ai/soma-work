---
name: Spoqa
colors:
  primary: '#00ab6e'
  primary-active: '#008c5e'
  ink: '#292f33'
  ink-alt: '#363a3c'
  body: '#434b4f'
  muted: '#717d85'
  muted-alt: '#5c6469'
  faint: '#a9afb3'
  canvas: '#ffffff'
  surface: '#f5f8fa'
  surface-alt: '#f8fafb'
  hairline: '#e4e9ed'
  hairline-alt: '#e1e4e6'
  on-primary: '#ffffff'
  accent-blue: '#4c80f1'
  accent-mint: '#76e8ad'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.29
    use: Hero headline + stat numerals, SHS Neo Bold
  display-md:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1
    use: Section statement, SHS Neo Medium
  sub-hero:
    fontSize: 32px
    fontWeight: 300
    lineHeight: 1.4
    use: Light sub-hero / timeline year, SHS Neo Thin-ish
  nav:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.5
    use: Top nav item (700 when active)
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, SHS Neo Regular
  button:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1
    use: CTA button label, SHS Neo Bold
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Form/select label, fine print
rounded:
  sm: 4px
  md: 10px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 28
  xxl: 32
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#00ab6e'
    textColor: '#ffffff'
    rounded: 10px
    padding: 20px 32px
    height: 67px
    typography: 18px / 700 Spoqa Han Sans Neo
    states: 'active/hover #008c5e'
    use: Primary CTA (키친보드 바로가기)
  button-dark:
    type: button
    backgroundColor: '#292f33'
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 10px
    padding: 20px 32px
    height: 69px
    typography: 18px / 700 Spoqa Han Sans Neo
    use: Secondary dark CTA (채용공고 보러가기)
  nav-item:
    type: tab
    textColor: '#434b4f'
    typography: 18px / 500 Spoqa Han Sans Neo
    padding: 0px 28px
    active: 'text #008c5e weight 700'
    use: Top navigation item
  select-input:
    type: input
    backgroundColor: '#f5f8fa'
    textColor: '#5c6469'
    rounded: 4px
    padding: 3px 7px
    height: 29px
    typography: 13px / 400 Spoqa Han Sans Neo
    use: Form select / filter control
  card-surface:
    type: card
    backgroundColor: '#f5f8fa'
    textColor: '#292f33'
    rounded: 16px
    use: Tinted content block on grey surface, separated by tint not shadow
  card-canvas:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#292f33'
    border: '1px solid #e4e9ed'
    rounded: 16px
    use: White feature card with hairline outline (no shadow)
  stat-figure:
    type: badge
    textColor: '#00ab6e'
    typography: 56px / 700 Spoqa Han Sans Neo
    use: Big green numeric metric (486,384 +)
  footer-link:
    type: listItem
    textColor: '#434b4f'
    typography: 18px / 400 Spoqa Han Sans Neo
    use: Footer / utility navigation link
fonts:
  roles:
    display: Spoqa Han Sans Neo
    body: Spoqa Han Sans Neo
---

# Spoqa

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Spoqa; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/spoqa/DESIGN.md
