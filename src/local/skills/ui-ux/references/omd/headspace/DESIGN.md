---
name: Headspace
colors:
  primary: '#0061ef'
  ink: '#2d2c2b'
  ink-pure: '#000000'
  body: '#4b4c4d'
  slate: '#44423f'
  canvas: '#f9f4f2'
  surface: '#ffffff'
  orange: '#ff7300'
  amber: '#ffa500'
  gold: '#ffce00'
  pink: '#ffa1cc'
  purple: '#3b197f'
  teal-navy: '#27455c'
  border-tan: '#e2ded9'
  border-input: '#d2d5de'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-1.92px'
    use: Hero / section headlines, Headspace Apercu Bold
  display-lg:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-1.56px'
    use: Large feature headlines
  display-md:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-1.44px'
    use: Secondary section heads
  feature:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-1.2px'
    use: Feature-card / band titles
  subsection:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.96px'
    use: Sub-section heads
  card-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.6px'
    use: Footer / card headings
  body-lg:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.44
    use: Intro / lead paragraphs
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.15
    use: Standard reading text
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    use: Primary button label
  button-sm:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    use: Compact nav CTA label
rounded:
  sm: 8px
  md: 12px
  lg: 24px
  pill: 32px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 40
  xxl: 64
components:
  button-primary:
    type: button
    backgroundColor: '#0061ef'
    textColor: '#ffffff'
    rounded: 32px
    padding: 14px 24px
    height: 48px
    typography: 14px / 700 Headspace Apercu
    use: Header / hero primary CTA — Headspace Blue pill
  button-dark:
    type: button
    backgroundColor: '#2d2c2b'
    textColor: '#ffffff'
    rounded: 32px
    padding: 14px 20px
    height: 48px
    typography: 16px / 700 Headspace Apercu
    use: Charcoal solid CTA — 'Try for $0', 'Check your coverage'
  button-soft:
    type: button
    backgroundColor: '#f9f4f2'
    textColor: '#44423f'
    rounded: 32px
    padding: 12px 24px
    height: 48px
    typography: 18px / 700 Headspace Apercu
    use: Cream pill secondary action — 'Get started', 'Learn more'
  pill-tab:
    type: tab
    backgroundColor: '#2d2c2b'
    textColor: '#ffffff'
    rounded: 24px
    padding: 0 24px
    height: 48px
    typography: 18px / 700 Headspace Apercu
    active: 'charcoal #2d2c2b fill, white label'
    use: 'Segmented pill selector — inactive is cream #f9f4f2 with #2d2c2b label'
  category-chip:
    type: badge
    backgroundColor: '#ff7300'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 12px
    typography: 14px / 500 Headspace Apercu
    use: Content-mode chips (Sleep/Meditate/Move) in the smiley orange family
  feature-card:
    type: card
    backgroundColor: '#f9f4f2'
    rounded: 24px
    use: Warm-cream feature card, shadowless
  color-card:
    type: card
    backgroundColor: '#0061ef'
    textColor: '#ffffff'
    rounded: 24px 24px 0 0
    use: 'Saturated color-block feature card (blue / gold #ffce00 variants)'
  plan-card:
    type: card
    backgroundColor: '#ffce00'
    textColor: '#000000'
    rounded: 12px
    padding: 24px
    border: '1px solid #ffce00'
    use: 'Selected subscription plan card — gold fill; unselected is #ffffff with 1px #44423f border'
  email-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #d2d5de'
    rounded: 8px
    padding: 24px 16px 8px
    height: 58px
    typography: 16px Headspace Apercu
    use: Email capture / float-label field
  play-button:
    type: button
    backgroundColor: '#2d2c2b'
    textColor: '#ffffff'
    rounded: 50%
    padding: 10px
    height: 48px
    use: 'Circular audio play/pause — also appears in orange #ff7300'
fonts:
  roles:
    sans: Headspace Apercu
---

# Headspace

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Headspace; reproduced for educational reference. Full prose: https://oh-my-design.kr/headspace/design.md
