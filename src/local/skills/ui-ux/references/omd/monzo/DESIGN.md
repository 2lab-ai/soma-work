---
name: Monzo
colors:
  primary: '#ff4f40'
  primary-alt: '#f64d3f'
  midnight: '#091723'
  deep-navy: '#112231'
  teal: '#016b83'
  canvas: '#ffffff'
  mint: '#f2f8f3'
  soft-mint: '#e3ebe4'
  ink: '#091723'
  body: '#6b747b'
  muted: '#b5b9bd'
  on-primary: '#ffffff'
  on-dark: '#ffffff'
  on-midnight: '#ffffff'
  hairline: '#c2c8d0'
typography:
  display-hero:
    fontSize: 61px
    fontWeight: 800
    lineHeight: 1
    use: Hero billboard, MonzoSansDisplay ExtraBold
  heading-lg:
    fontSize: 49px
    fontWeight: 800
    lineHeight: 1.15
    use: Section titles (clamp ~48.8px at 1440px)
  heading:
    fontSize: 39px
    fontWeight: 800
    lineHeight: 1.2
    use: Sub-section heads (clamp ~39px)
  subheading:
    fontSize: 25px
    fontWeight: 800
    lineHeight: 1.3
    use: Card heads, H3, footer category (MonzoSansDisplay)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    use: Standard reading text, MonzoSansText
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Captions, metadata
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    use: Button labels, MonzoSansText SemiBold
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Nav links, MonzoSansText
rounded:
  xs: 4px
  sm: 24px
  md: 32px
  lg: 64px
  full: 500px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 24
  lg: 32
  xl: 48
  xxl: 64
  section: 80
components:
  button-primary:
    type: button
    backgroundColor: '#091723'
    textColor: '#ffffff'
    rounded: 500px
    padding: 12px 24px
    typography: 16px / 600 MonzoSansText
    use: Primary CTA on home ('Sign up')
  button-teal:
    type: button
    backgroundColor: '#016b83'
    textColor: '#ffffff'
    rounded: 500px
    padding: 12px 24px
    typography: 16px / 600 MonzoSansText
    use: Product-page primary CTA ('Open a personal account')
  button-white:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#091723'
    rounded: 500px
    padding: 12px 24px
    typography: 16px / 600 MonzoSansText
    use: Hero-dark surface CTA ('Open a free bank account')
  button-chip:
    type: button
    backgroundColor: '#3b4c54'
    textColor: '#ffffff'
    rounded: 64px
    padding: 8px 16px
    typography: 16px / 600 MonzoSansText
    use: Filter chip / feature tab ('Free features')
  input-search:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #c2c8d0'
    rounded: 500px
    typography: 16px MonzoSansText
    shadow: rgba(0,0,0,0.1) 0px 0px 10px 0px
    use: Search field on light background
  card-mint:
    type: card
    backgroundColor: '#f2f8f3'
    rounded: 32px
    use: Tinted content card on mint surface
  card-white:
    type: card
    backgroundColor: '#ffffff'
    rounded: 32px
    use: White feature card on mint background
  card-dark:
    type: card
    backgroundColor: '#091723'
    textColor: '#ffffff'
    rounded: 32px
    use: Dark card on brand dark surface
  badge-coral:
    type: badge
    backgroundColor: '#ff4f40'
    textColor: '#ffffff'
    rounded: 4px
    use: Hot Coral accent badge / tag
  nav-tab:
    type: tab
    textColor: '#091723'
    typography: 16px / 400 MonzoSansText
    use: 'Top nav item; active = coral #ff4f40 text'
fonts:
  roles:
    display: MonzoSansDisplay
    body: MonzoSansText
---

# Monzo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Monzo; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/monzo/DESIGN.md
