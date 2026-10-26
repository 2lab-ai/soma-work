---
name: Salesforce
colors:
  primary: '#0176d3'
  primary-dark: '#0b5cab'
  navy: '#032d60'
  hero-navy: '#002c6e'
  brand-bright: '#1b96ff'
  sky: '#00a1e0'
  ink: '#080707'
  ink-soft: '#181818'
  canvas: '#ffffff'
  cloud-tint: '#eaf5fe'
  surface: '#f4f4f4'
  hairline: '#e5e5e5'
  error: '#ea001e'
  success: '#2e844a'
  warning: '#dd7a01'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 70px
    fontWeight: 400
    lineHeight: 1
    use: Homepage hero H1, ITC Avant Garde
  display-lg:
    fontSize: 60px
    fontWeight: 400
    lineHeight: 1
    use: Dark-section statement H2
  display-md:
    fontSize: 56px
    fontWeight: 400
    lineHeight: 1.14
    use: Page-level H1 (pricing)
  section:
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: '-0.32px'
    use: Section H2
  subsection:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: '-0.06px'
    use: Card H3, ITC Avant Garde
  card-title:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.08px'
    use: Industry/product card heads
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.56
    use: Inline links, intro copy, Salesforce Sans
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, Salesforce Sans
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.02px
    use: CTA labels, Salesforce Sans Bold
  link-sm:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.43
    use: Tertiary 'Learn more' text CTAs
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  xl: 32px
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
  max: 80
components:
  button-primary:
    type: button
    backgroundColor: '#0176d3'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 32px
    height: 52px
    typography: 16px / 700
    border: '2px solid #0176d3'
    use: Primary CTA — 'Start for free', 'Calculate pricing'
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0176d3'
    rounded: 4px
    padding: 12px 32px
    height: 52px
    typography: 16px / 700
    border: '2px solid #0176d3'
    use: Paired outline CTA — 'Watch demo'
  button-tertiary:
    type: button
    textColor: '#032d60'
    rounded: 4px
    typography: 14px / 700
    use: '''Learn more'' text CTA on cards'
  carousel-control:
    type: button
    textColor: '#ffffff'
    rounded: 9999px
    height: 48px
    border: '2px solid #ffffff'
    use: Prev/next/pause controls on testimonial carousel
  card-glass:
    type: card
    textColor: '#ffffff'
    rounded: 32px
    border: 2px solid rgba(255,255,255,0.1)
    padding: 19px
    use: Translucent product tile (Slack/Agentforce/Customer 360/Data 360) on dark hero, bg rgba(255,255,255,0.05)
  card-media:
    type: card
    textColor: '#080707'
    rounded: 22px
    use: Customer-story video testimonial card
  card-tint:
    type: card
    backgroundColor: '#eaf5fe'
    textColor: '#032d60'
    use: Light cloud-blue section band / promo panel
  nav-link:
    type: tab
    textColor: '#080707'
    typography: 16px / 400
    active: 'text #0176d3'
    use: Global nav item
fonts:
  roles:
    display: ITC Avant Garde (AvantGardeForSalesforce)
    body: Salesforce Sans
    app: system-ui (SLDS 2 product UI)
---

# Salesforce

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Salesforce; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/salesforce/DESIGN.md
