---
name: Patreon
colors:
  primary: '#000000'
  on-primary: '#ffffff'
  canvas: '#ffffff'
  ink: '#1a1a1a'
  black: '#000000'
  muted: '#999999'
  hairline: '#cccccc'
  near-black: '#0f0c13'
  brand-blue: '#002a57'
  accent-cornflower: '#71a0ff'
  accent-periwinkle: '#94bbff'
  accent-sage: '#9fb08b'
typography:
  display-hero:
    fontSize: 125px
    fontWeight: 250
    lineHeight: 0.98
    letterSpacing: '-7.5px'
    use: Hero wordmark headline, Oracle ultra-light (live computed 187.5px @1.5× root)
  display-section:
    fontSize: 85px
    fontWeight: 250
    lineHeight: 0.87
    letterSpacing: '-5.1px'
    use: Section display headline, Oracle ultra-light (live 127.5px)
  stat:
    fontSize: 48px
    fontWeight: 250
    lineHeight: 0.8
    letterSpacing: '-1.92px'
    use: Big stat figure e.g. '10%' (live 72px)
  label-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    use: Section label / eyebrow, Oracle (live 30px)
  subhead:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: '-0.3px'
    use: Feature subheading, Oracle (live 22.5px)
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Body / card copy, Oracle
  nav:
    fontSize: 9px
    fontWeight: 400
    use: Nav item label, Oracle (live 13.5px)
  button:
    fontSize: 9px
    fontWeight: 350
    use: Button / CTA label, Oracle (live 13.5px)
rounded:
  sm: 15px
  md: 20px
  lg: 30px
  pill: 45px
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
  button-primary-dark:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 30px
    padding: 15px 21px
    height: 47px
    typography: 9px / 350 Oracle
    border: '1px solid #000000'
    use: Primary CTA on light surfaces — 'Get started'
  button-primary-light:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 30px
    padding: 15px 21px
    height: 47px
    typography: 9px / 350 Oracle
    border: '1px solid #ffffff'
    use: Primary CTA on dark/photo hero — 'Get Started'
  button-outline:
    type: button
    textColor: '#ffffff'
    rounded: 30px
    padding: 15px 21px
    height: 47px
    border: '1px solid #ffffff'
    typography: 9px / 350 Oracle
    use: Secondary outline on dark — 'Log in', 'Updates'
  nav-item:
    type: tab
    textColor: '#ffffff'
    rounded: 30px
    padding: 11px 18px
    height: 47px
    typography: 9px / 400 Oracle
    active: underline / hover bg rgba(255,255,255,0.16)
    use: Top nav menu item on dark header
  search-input:
    type: input
    textColor: '#ffffff'
    rounded: 45px
    height: 45px
    typography: 9px / 350 Oracle
    use: '''Find a Creator'' pill search on dark, translucent fill rgba(255,255,255,0.16)'
  card-pricing:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 30px
    border: '1px solid #cccccc'
    use: Pricing / feature card — shadow-free, hairline outline
  chip-translucent:
    type: badge
    textColor: '#ffffff'
    rounded: 9999px
    typography: 9px / 400 Oracle
    use: Language / utility chip on dark, fill rgba(255,255,255,0.16)
  accent-band:
    type: card
    backgroundColor: '#94bbff'
    textColor: '#000000'
    rounded: 30px
    use: Expressive periwinkle feature band — color as creator energy, not chrome
fonts:
  roles:
    display: Oracle
    body: Oracle
---

# Patreon

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Patreon; reproduced for educational reference. Full prose: https://oh-my-design.kr/patreon/design.md
