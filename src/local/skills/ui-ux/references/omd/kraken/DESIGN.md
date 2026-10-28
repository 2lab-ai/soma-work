---
name: Kraken
colors:
  primary: '#7132f5'
  primary-hover: '#5741d8'
  primary-deep: '#5b1ecf'
  brand: '#7132f5'
  canvas: '#ffffff'
  foreground: '#101114'
  muted: '#9497a9'
  on-primary: '#ffffff'
  hairline: '#dedee5'
  body: '#686b82'
  success: '#149e61'
  success-text: '#026b3f'
  error: '#d54848'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.17
    letterSpacing: '-1px'
    use: Hero headline, Kraken-Brand
  section-heading:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: '-0.5px'
    use: Section heading, Kraken-Brand
  sub-heading:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    letterSpacing: '-0.5px'
    use: Sub-heading, Kraken-Brand
  feature-title:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.2
    use: Feature title, Kraken-Product
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.38
    use: Body text
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.38
    use: Button label
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Caption
  small:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Small text
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 25
components:
  button-primary:
    type: button
    backgroundColor: '#7132f5'
    textColor: '#ffffff'
    padding: 13px 16px
    rounded: 12px
    typography: 16px / 500
    use: Primary CTA, links
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5741d8'
    border: '1px solid #5741d8'
    rounded: 12px
    use: Outlined purple variant
  button-subtle:
    type: button
    backgroundColor: rgba(133,91,251,0.16)
    textColor: '#7132f5'
    padding: 8px
    rounded: 12px
    use: Subtle/ghost purple button
  button-white:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#101114'
    rounded: 10px
    shadow: rgba(0,0,0,0.03) 0px 4px 24px
    use: White button
  button-secondary:
    type: button
    backgroundColor: rgba(148,151,169,0.08)
    textColor: '#101114'
    rounded: 12px
    use: Secondary gray button
  badge-success:
    type: badge
    backgroundColor: rgba(20,158,97,0.16)
    textColor: '#026b3f'
    rounded: 6px
    use: Success/positive badge
  badge-neutral:
    type: badge
    backgroundColor: rgba(104,107,130,0.12)
    textColor: '#484b5e'
    rounded: 8px
    use: Neutral badge
  card:
    type: card
    backgroundColor: '#ffffff'
    border: 1px solid rgba(148,151,169,0.16)
    rounded: 12px
    padding: 24px
    shadow: rgba(0,0,0,0.03) 0px 4px 24px
    use: Default card, subtle lift
  card-stat:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 20px 24px
    use: Stat/metric card, value 28px/700, delta green/red
  card-featured:
    type: card
    backgroundColor: 'linear-gradient(135deg, #7132f5 0%, #5741d8 100%)'
    textColor: '#ffffff'
    rounded: 16px
    padding: 32px
    shadow: inset 0 0 60px rgba(255,255,255,0.08)
    use: Featured/promotional card, used sparingly
fonts:
  roles:
    sans: Kraken-Product
    mono: IBM Plex Sans
---

# Kraken

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kraken; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kraken/DESIGN.md
