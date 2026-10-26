---
name: The Verge
colors:
  primary: '#5200ff'
  accent: '#3cffd0'
  canvas: '#131313'
  surface: '#2d2d2d'
  image-frame: '#313131'
  border-strong: '#c2c2c2'
  text-muted: '#e9e9e9'
  text-secondary: '#949494'
  on-primary: '#ffffff'
  link-hover: '#3860be'
  focus: '#1eaedb'
typography:
  display-mega:
    fontSize: 107px
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: '-0.02px'
    use: Hero/feature splash headlines
  display-lg:
    fontSize: 72px
    fontWeight: 900
    lineHeight: 1
    letterSpacing: '-0.02px'
    use: Section/package headlines
  display:
    fontSize: 60px
    fontWeight: 900
    lineHeight: 1.02
    letterSpacing: '-0.01px'
    use: Story-tile headlines
  headline:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.01px'
    use: Sub-feature, card titles
  title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.2
    use: List headlines, module titles
  subtitle:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.35
    use: Deks, standfirst
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.55
    use: Article body lead
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: Standard article reading text
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Secondary text, captions
  kicker:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.06px
    use: UPPERCASE section tags, kickers
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Bylines, timestamps, credits
rounded:
  sm: 3px
  md: 3px
  lg: 3px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
components:
  button-primary:
    type: button
    backgroundColor: '#5200ff'
    textColor: '#ffffff'
    rounded: 3px
    padding: 12px 20px
    typography: 14/600
    use: Primary CTA Subscribe, Read more
  button-accent:
    type: button
    backgroundColor: '#3cffd0'
    textColor: '#131313'
    rounded: 3px
    padding: 12px 20px
    typography: 14/600
    use: High-energy secondary CTA on dark canvas
  button-outline:
    type: button
    textColor: '#ffffff'
    rounded: 3px
    padding: 12px 20px
    typography: 14/600
    use: 'Secondary action on dark, 1px border #c2c2c2'
  badge-pill:
    type: badge
    textColor: '#3cffd0'
    rounded: 9999px
    padding: 4px 12px
    typography: 12/600
    use: Section tags, topic chips, UPPERCASE mono, 1px accent border
  input-default:
    type: input
    backgroundColor: '#2d2d2d'
    textColor: '#ffffff'
    rounded: 3px
    padding: 12px 14px
    typography: 16/400
    use: Newsletter signup, search, comment box
  input-error:
    type: input
    backgroundColor: '#2d2d2d'
    textColor: '#ffffff'
    rounded: 3px
    padding: 12px 14px
    typography: 16/400
    use: 'Validation error, 1px border #5200ff'
  card-tile:
    type: card
    backgroundColor: '#5200ff'
    textColor: '#ffffff'
    rounded: 3px
    padding: 20px
    use: Signature color-block story tile, Manuka 60/900 headline
  card-standard:
    type: card
    backgroundColor: '#131313'
    textColor: '#ffffff'
    rounded: 3px
    padding: 16px
    use: StoryStream rows, list modules, mint kicker
  card-inverted:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#131313'
    rounded: 3px
    padding: 16px
    use: Sponsored / special sections on light
  tab-nav:
    type: tab
    textColor: '#ffffff'
    use: 'Top nav section list on #131313'
    active: 'underline or #5200ff marker'
fonts:
  roles:
    sans: PolySans
    mono: PolySans Mono
---

# The Verge

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to The Verge; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/theverge/DESIGN.md
