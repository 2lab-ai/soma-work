---
name: JKOPay
colors:
  primary: '#c9191d'
  primary-hover: '#d51b1f'
  primary-dark: '#851113'
  body: '#42434a'
  dark-bg: '#171718'
  dark-nav: '#292f40'
  surface: '#f4f4f6'
  border: '#ededf1'
  placeholder: '#b7b8c4'
  blue-accent: '#2e7dd9'
  white: '#ffffff'
typography:
  display:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.5
    use: Display / hero headline
  heading:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.5
    use: Heading LG-3, section labels
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Body SM reading text
  button:
    fontSize: 17px
    fontWeight: 500
    use: Button label, medium
  caption:
    fontSize: 13px
    fontWeight: 400
    use: Caption / body SM-1
rounded:
  sm: 9px
  md: 12px
  lg: 16px
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
    backgroundColor: '#c9191d'
    textColor: '#ffffff'
    rounded: 12px
    padding: 12px 29px
    typography: 17px weight 500
    use: 'Solid red primary CTA, hover #d51b1f'
  button-ghost:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#c9191d'
    rounded: 9px
    padding: 12px 24px
    typography: 17px weight 500
    use: Ghost secondary, 1px red border
  nav:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#42434a'
    use: Frosted-glass top nav, white at 0.80 alpha
  card:
    type: card
    backgroundColor: '#f4f4f6'
    rounded: 12px
    use: Card surface, white-to-warm-gray gradient, subtle shadow
  input:
    type: input
    backgroundColor: '#f4f4f6'
    textColor: '#42434a'
    use: Input fill, surface gray
  link-blue:
    type: badge
    textColor: '#2e7dd9'
    use: Informational link / secondary highlight
fonts:
  roles:
    sans: PingFang TC
    fallback: apple-system, source-han-sans-traditional, sans-serif
---

# JKOPay

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to JKOPay; reproduced for educational reference. Full prose: https://oh-my-design.kr/jkopay/design.md
