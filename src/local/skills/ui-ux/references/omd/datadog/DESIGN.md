---
name: Datadog
colors:
  primary: '#632ca6'
  brand-violet: '#8000ff'
  brand-violet-live: '#7700ff'
  ink: '#212529'
  ink-pure: '#000000'
  body: '#333333'
  muted: '#555555'
  faint: '#c7c7c7'
  canvas: '#ffffff'
  surface: '#f5f5f5'
  surface-alt: '#eeeeee'
  dark-chip: '#323232'
  footer-bg: '#110617'
  hairline: '#e1e5e9'
  error: '#bf0000'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 68px
    fontWeight: 600
    lineHeight: 1
    use: Hero headline, NationalWeb SemiBold
  section:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.11
    use: Section titles
  intro:
    fontSize: 22px
    fontWeight: 300
    lineHeight: 1.43
    use: Hero sub / intro lede, NationalWeb Light
  nav:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1
    use: Top nav links
  button:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1
    use: Primary/secondary CTA label
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 28
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#632ca6'
    textColor: '#ffffff'
    rounded: 4px
    padding: 16px 24px
    height: 54px
    typography: 18px / 700 NationalWeb
    states: transition 0.15s ease-in-out
    use: Primary CTA — Free trial / Get started
  button-primary-compact:
    type: button
    backgroundColor: '#632ca6'
    textColor: '#ffffff'
    rounded: 6px
    padding: 8px 14px
    height: 38px
    typography: 18px / 600 NationalWeb
    use: Compact primary CTA on pricing cards — Start Free Trial
  button-outline:
    type: button
    textColor: '#632ca6'
    border: '1px solid #632ca6'
    rounded: 4px
    padding: 14px 24px 16px
    height: 54px
    typography: 18px / 700 NationalWeb
    use: Secondary CTA on light — SEE THE PLATFORM
  button-ghost-dark:
    type: button
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 6px
    height: 50px
    typography: 18px / 600 NationalWeb
    use: Secondary CTA on dark sections — Free Trial
  nav-link:
    type: tab
    textColor: '#555555'
    typography: 18px / 600 NationalWeb
    padding: 8.5px 12px 9.5px
    active: 'purple #632ca6 text on active'
    use: Top nav item
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#212529'
    border: '1px solid #e1e5e9'
    rounded: 4px
    padding: 0px 10px 0px 35px
    typography: 18px NationalWeb
    use: Header search field, left icon inset
  card-pricing:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#212529'
    rounded: 8px
    padding: 0px 0px 16px
    use: Pricing plan card, 8px bottom corners, no shadow
  region-select:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    padding: 7px 10px 9px 12px
    height: 34px
    typography: 18px NationalWeb
    use: Region/datacenter select control on pricing
fonts:
  roles:
    display: NationalWeb
    body: NationalWeb
    fallback: Helvetica, Arial, sans-serif
---

# Datadog

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Datadog; reproduced for educational reference. Full prose: https://oh-my-design.kr/datadog/design.md
