---
name: WIRED
colors:
  ink: '#000000'
  canvas: '#ffffff'
  accent: '#e90c17'
  accent-hover: '#c20a13'
  ink-800: '#1a1a1a'
  body: '#333333'
  secondary: '#555555'
  metadata: '#767676'
  disabled: '#999999'
  line: '#cccccc'
  line-soft: '#e2e2e2'
  band: '#f4f4f4'
  surface-50: '#fafafa'
  error: '#cc0000'
  success: '#0a7d3f'
  warning: '#b86e00'
  info: '#0a66c2'
typography:
  display-mega:
    fontSize: 72px
    fontWeight: 700
    lineHeight: 0.94
    letterSpacing: '-0.01px'
    use: Feature hero, cover-story title, all-caps
  display-hero:
    fontSize: 54px
    fontWeight: 700
    lineHeight: 0.96
    letterSpacing: '-0.01px'
    use: Section fronts, big headlines
  headline-xl:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1
    use: Article H1
  headline-l:
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.07
    use: Card headlines, list leads
  headline-m:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.08
    use: Secondary cards, related links
  deck:
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.36
    use: Article sub-headline, serif standfirst
  subtitle:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.44
    use: Section labels, in-article H2
  body-large:
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.58
    use: Long-form article body
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: UI text, captions context
  body-small:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Metadata, secondary info
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Photo credits, fine print
  eyebrow:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: 0.08px
    use: ALL-CAPS section tag above headlines
rounded:
  sm: 0px
  md: 2px
  lg: 2px
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
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 2px
    padding: 14px 28px
    typography: 15px / 700
    use: Primary utility action (Save, Continue, Read More)
  button-subscribe:
    type: button
    backgroundColor: '#e90c17'
    textColor: '#ffffff'
    rounded: 2px
    padding: 14px 28px
    typography: 15px / 700
    use: Subscription CTA, conversion moments (SUBSCRIBE, JOIN WIRED)
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 2px
    padding: 12.5px 26px
    typography: 15px / 700
    use: Secondary action paired with a black/red primary
  button-link:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#e90c17'
    typography: 16px / 700
    use: Inline tertiary actions, More stories, section jumps
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 2px
    padding: 12px 14px
    typography: 16px / 400
    use: Newsletter signup, search, account forms
  input-search:
    type: input
    backgroundColor: '#f4f4f4'
    textColor: '#1a1a1a'
    rounded: 2px
    padding: 12px 16px
    typography: 16px / 400
    use: Site-wide search overlay
  card-story:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    padding: 16px 0
    use: River of stories on section/index pages, 1px rule separators
  card-promo:
    type: card
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 2px
    padding: 32px
    use: In-feed subscription and membership promos
  badge-flag:
    type: badge
    backgroundColor: '#e90c17'
    textColor: '#ffffff'
    rounded: 0px
    padding: 3px 8px
    typography: 11px / 700
    use: BREAKING, EXCLUSIVE, live flags
  badge-tag:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    padding: 3px 8px
    typography: 11px / 700
    use: Section labels (SECURITY, SCIENCE, BUSINESS, GEAR)
  tab-subnav:
    type: tab
    textColor: '#000000'
    active: '2px #e90c17 bottom border'
    use: Within-section tabs (Latest, Most Popular)
  toast-error:
    type: toast
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 2px
    typography: 14px / 400
    use: Error toast, 4s auto-dismiss, bottom-center
fonts:
  roles:
    sans: Akkurat
    mono: Akkurat Mono
---

# WIRED

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to WIRED; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/wired/DESIGN.md
