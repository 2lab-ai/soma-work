---
name: SHOPLINE
colors:
  primary: '#356dff'
  primary-ink: '#ffffff'
  ink: '#00142d'
  canvas: '#ffffff'
  surface-tint: '#edf4fd'
  surface-mist: '#f2f7fc'
  dark-section: '#00142d'
  heading: '#00142d'
  body: '#00142d'
  on-dark: '#ffffff'
  cta-black: '#000000'
  hairline: '#d6d6d6'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: 0px
    use: Hero headline (h1), white-on-navy
  section:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.37
    letterSpacing: 0px
    use: Section titles (h2)
  subheading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Card / feature heads
  cta-lg:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1
    use: Primary pill CTA label
  cta-sm:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    use: Nav header CTA label
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Top navigation links
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.85
    use: Small descriptions, metadata
rounded:
  sm: 3px
  md: 6px
  lg: 9px
  pill: 30px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 80
components:
  button-primary:
    type: button
    backgroundColor: '#356dff'
    textColor: '#ffffff'
    rounded: 30px
    height: 45px
    padding: 0 24px
    typography: 18px / 700
    use: Primary marketing CTA
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#356dff'
    border: '1px solid #356dff'
    rounded: 30px
    height: 45px
    typography: 18px / 700
    use: Secondary action beside primary
  button-dark:
    type: button
    backgroundColor: '#00142d'
    textColor: '#ffffff'
    rounded: 30px
    height: 44px
    padding: 8px 24px
    typography: 16px / 700
    use: High-emphasis booking/conversion CTA
  button-nav:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 30px
    height: 38px
    padding: 0 24px
    typography: 14px / 700
    use: Always-visible free-trial CTA in sticky nav
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    shadow: rgba(0,0,0,0.08) 0px 8px 16px 0px
    use: Standard elevated card; elevation from soft shadow not hairlines
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#00142d'
    border: '1px solid #d6d6d6'
    rounded: 6px
    focus: '#356dff blue ring/border'
    use: Form input
  section-band:
    type: card
    backgroundColor: '#edf4fd'
    use: 'Light-blue wash band (#edf4fd / #f2f7fc) alternating with white; navy #00142d for immersive sections'
fonts:
  roles:
    sans: Noto Sans TC
    fallback: '-apple-system, system-ui, Segoe UI, Roboto'
---

# SHOPLINE

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SHOPLINE; reproduced for educational reference. Full prose: https://oh-my-design.kr/shopline/design.md
