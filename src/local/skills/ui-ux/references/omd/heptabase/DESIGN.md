---
name: Heptabase
colors:
  ink: '#2e2e2e'
  ink-pure: '#000000'
  canvas: '#f7f7f7'
  surface: '#ffffff'
  surface-tint: '#fcfcfc'
  surface-warm: '#f0f0ea'
  accent-blue: '#207dff'
  accent-green: '#75c33a'
  muted: '#6a6972'
  muted-warm: '#777169'
  hairline: '#e5e7eb'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: '-1.584px'
    use: Hero headline, Instrument Sans Medium
  section:
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: '-0.54px'
    use: Section titles, Instrument Sans
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.5
    use: Pricing tier / card titles, Inter SemiBold
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Nav links, Inter
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, Inter
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1
    use: Header CTA label, Inter Medium
  pill:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1
    use: Segmented sub-nav pill, Inter
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  pill: 9999px
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
    backgroundColor: '#2e2e2e'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 8px 16px
    height: 36px
    typography: 16px / 500 Inter
    use: Header 'Get started' CTA — solid near-black pill
  button-cta-lg:
    type: button
    backgroundColor: '#2e2e2e'
    textColor: '#ffffff'
    rounded: 10px
    padding: 14px 24px
    height: 48px
    typography: 16px / 600 Inter
    use: Hero / pricing primary CTA — rounded-rect
  button-ghost:
    type: button
    backgroundColor: '#fcfcfc'
    textColor: '#2e2e2e'
    border: 1px solid rgba(0,0,0,0.08)
    rounded: 10px
    padding: 13px 23px
    height: 48px
    typography: 18px / 500 Inter
    use: Secondary pricing CTA on translucent fill
  nav-link:
    type: tab
    textColor: '#2e2e2e'
    rounded: 8px
    padding: 8px 12px
    typography: 16px / 400 Inter
    active: 'text #2e2e2e on hover tint'
    use: Top nav item
  subnav-pill:
    type: tab
    textColor: '#777169'
    rounded: 9999px
    padding: 7px 22px
    typography: 13px / 500 Inter
    active: 'text #000000 + filled pill'
    use: Product sub-nav segmented pills (Home / AI Tutor)
  pricing-card:
    type: card
    backgroundColor: '#fcfcfc'
    border: 1px solid rgba(0,0,0,0.08)
    rounded: 12px
    use: Pricing tier column on translucent fill, no shadow
  canvas-card:
    type: card
    backgroundColor: '#ffffff'
    border: 1px solid rgba(0,0,0,0.14)
    rounded: 8px
    use: White product mock card
  feature-card:
    type: card
    backgroundColor: '#f0f0ea'
    border: 1px solid rgba(0,0,0,0.04)
    rounded: 8px
    use: Warm feature tile on canvas
  toggle-segment:
    type: toggle
    backgroundColor: '#ffffff'
    textColor: '#2e2e2e'
    rounded: 8px
    padding: 6px 10px
    use: Monthly / Yearly billing switch
fonts:
  roles:
    display: Instrument Sans
    body: Inter
    cjk: system CJK (PingFang TC / Noto Sans TC)
---

# Heptabase

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Heptabase; reproduced for educational reference. Full prose: https://oh-my-design.kr/heptabase/design.md
