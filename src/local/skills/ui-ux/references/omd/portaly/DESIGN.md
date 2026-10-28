---
name: Portaly
colors:
  primary: '#862983'
  teal: '#00a6a3'
  teal-alt: '#12a3a0'
  teal-soft: '#38aaaa'
  purple-hero: '#6e28af'
  purple-hero-light: '#ac8ffe'
  swoosh-magenta: '#bb53b9'
  navy: '#0c2340'
  navy-deep: '#1a2a3a'
  ink: '#333333'
  ink-pure: '#000000'
  muted: '#969696'
  canvas: '#f8f8f8'
  surface: '#ffffff'
  surface-alt: '#f2f2f2'
  hairline: '#d9d9d9'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 50px
    fontWeight: 800
    lineHeight: 1.38
    letterSpacing: 1px
    use: Hero headline, Noto Sans ExtraBold
  feature-xl:
    fontSize: 50px
    fontWeight: 700
    lineHeight: 1.5
    use: Large feature statement (Turn Traffic into Revenue)
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    use: Section titles
  feature:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: Feature card heads
  lede:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    use: Hero subhead / lede
  nav:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.33
    use: Nav links, Noto Sans SemiBold
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
rounded:
  sm: 6px
  md: 12px
  lg: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 40
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#862983'
    textColor: '#ffffff'
    rounded: 6px
    padding: 4px 16px
    height: 32px
    typography: 16px / 600 Noto Sans
    use: Primary CTA on pricing (Join Now), hover deepens plum
  button-primary-lg:
    type: button
    backgroundColor: '#862983'
    textColor: '#ffffff'
    rounded: 20px
    padding: 24px 40px
    height: 52px
    typography: 18px / 600 Noto Sans
    use: Large primary CTA (Start Free)
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#862983'
    border: '1px solid #862983'
    rounded: 6px
    padding: 4px 16px
    height: 32px
    typography: 16px / 600 Noto Sans
    use: Secondary CTA (Start for Free), magenta outline
  button-hero-ghost:
    type: button
    textColor: '#ffffff'
    border: '2px solid #ffffff'
    rounded: 9999px
    padding: 14px 70px
    typography: 28px / 600 Noto Sans
    use: White outline pill CTA over the purple hero gradient
  nav-link:
    type: tab
    textColor: '#0c2340'
    typography: 18px / 600 Noto Sans
    active: 'magenta #862983 text on the active item'
    use: Top nav item (Features, Pricing, Portaly AI, Blog)
  plan-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    shadow: rgba(99,99,99,0.2) 0px 2px 8px 0px
    use: 'Pricing plan card on #f8f8f8 canvas, no border'
  link-block:
    type: card
    backgroundColor: '#ffffff'
    rounded: 6px
    padding: 8px 16px
    typography: 16px / 600 Noto Sans
    use: Creator-page link block (filled 6px / rounded 16px variants); accent color is creator-chosen
  toggle-billing:
    type: toggle
    backgroundColor: '#d9d9d9'
    rounded: 9999px
    height: 24px
    use: 'Annual/Monthly billing switch, magenta #862983 active thumb'
  feature-check:
    type: badge
    textColor: '#12a3a0'
    typography: 16px / 400 Noto Sans
    use: Teal checkmark in plan feature lists
fonts:
  roles:
    sans: Noto Sans
    cjk: Noto Sans TC
---

# Portaly

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Portaly; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/portaly/DESIGN.md
