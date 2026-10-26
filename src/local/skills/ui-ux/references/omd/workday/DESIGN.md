---
name: Workday
colors:
  primary: '#0057ae'
  blueberry: '#0875e1'
  blueberry-500: '#005cb9'
  blueberry-600: '#004387'
  ink: '#022043'
  heading: '#333333'
  body: '#494949'
  label: '#787878'
  hint: '#5e6a75'
  input-border: '#7b858f'
  card-border: '#b6c1cc'
  canvas: '#ffffff'
  surface: '#f0f1f2'
  surface-tint: '#d7eafc'
  divider: '#dfe2e6'
  yellow: '#fec10b'
  cantaloupe: '#f38b00'
  error: '#de2e21'
  success: '#43c463'
  warning: '#ffa126'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 800
    lineHeight: 1.14
    letterSpacing: '-1.12px'
    use: Hero headline, Acid Grotesk ExtraBold
  section:
    fontSize: 40px
    fontWeight: 800
    lineHeight: 1.2
    use: Section headlines, Acid Grotesk ExtraBold
  eyebrow:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.43
    letterSpacing: 1.12px
    use: Uppercase eyebrow / section label
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  nav:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Nav items, bold
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    use: CTA pill label
rounded:
  sm: 8px
  md: 12px
  lg: 24px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#0057ae'
    textColor: '#ffffff'
    rounded: 24px
    padding: 0px 20px
    height: 48px
    typography: 16px / 700 Acid Grotesk
    use: Marketing primary CTA — Contact Sales, Play Demo (blue pill)
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#022043'
    border: '2px solid #022043'
    rounded: 24px
    padding: 0px 20px
    height: 48px
    typography: 16px / 700 Acid Grotesk
    use: Marketing secondary CTA — Learn More, Read Report (ghost pill)
  button-canvas-primary:
    type: button
    backgroundColor: '#f38b00'
    textColor: '#ffffff'
    rounded: 999px
    typography: 14px / 700 Roboto
    states: 'hover #c06c00 · focus 2px #0875e1 ring'
    use: Canvas DS product action button (cantaloupe primary)
  nav-item:
    type: tab
    textColor: '#022043'
    typography: 16px / 700 Acid Grotesk
    active: 'blueberry #0875e1 text/underline on active'
    use: Top nav (Products, Industries, Customers, Resources, Partners, Company)
  text-link:
    type: tab
    textColor: '#0875e1'
    typography: 16px / 400 Acid Grotesk
    active: 'blueberry #0875e1 link, underline on hover'
    use: Inline text link
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#494949'
    border: '1px solid #7b858f'
    rounded: 4px
    padding: 8px 12px
    typography: 14px / 400 Roboto
    states: 'focus 1px #0875e1 · placeholder #5e6a75'
    use: Canvas DS form text input
  card-resource:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#0057ae'
    border: '1px solid #b6c1cc'
    rounded: 8px
    padding: 24px
    use: Whitepaper / resource card on marketing surface
  card-tint:
    type: card
    backgroundColor: '#d7eafc'
    textColor: '#022043'
    rounded: 8px
    padding: 24px
    use: Tinted blueberry-100 highlight card / callout
  badge-status:
    type: badge
    backgroundColor: '#d7eafc'
    textColor: '#004387'
    rounded: 999px
    padding: 4px 12px
    typography: 12px / 700 Acid Grotesk
    use: Status / category pill
  toast-error:
    type: toast
    backgroundColor: '#ffffff'
    textColor: '#494949'
    border: '1px solid #de2e21'
    rounded: 4px
    use: Canvas DS error message (cinnamon border)
fonts:
  roles:
    display: Acid Grotesk
    body: Acid Grotesk
    fallback: Arial, Helvetica, sans-serif
---

# Workday

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Workday; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/workday/DESIGN.md
