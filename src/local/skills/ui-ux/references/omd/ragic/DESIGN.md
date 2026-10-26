---
name: Ragic
colors:
  primary: '#f70e0e'
  primary-deep: '#d50e0e'
  accent-red: '#fa3e3e'
  link: '#0066cc'
  accent-blue: '#65a4f4'
  blue-tint: '#e8f0fb'
  canvas: '#ffffff'
  surface: '#fafafa'
  surface-gray: '#efefef'
  heading: '#000000'
  body: '#222222'
  label: '#333333'
  muted: '#aaaaaa'
  slate: '#73859f'
  panel-dark: '#2b333f'
  hairline: '#dddddd'
  on-primary: '#ffffff'
typography:
  h1:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-1px'
    use: Hero headline — bold, tightly tracked
  h2:
    fontSize: 32px
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: 0px
    use: Section titles — heaviest weight on the page
  stat:
    fontSize: 32px
    fontWeight: 300
    letterSpacing: 0px
    use: Large numeric stats in accent-red (#fa3e3e)
  cta-label:
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1
    use: Primary 'Create account' button label
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    use: Standard reading text, 24px line-height
  button:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1
    use: Tab / filter chip buttons
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.2
    use: Small UI labels, table chrome
rounded:
  sm: 2px
  md: 5px
  lg: 6px
  pill: 9px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 30
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#f70e0e'
    textColor: '#ffffff'
    rounded: 6px
    padding: 14px 30px
    typography: weight 600
    use: Primary 'Create account' CTA
  tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#aaaaaa'
    rounded: 5px
    padding: 8px 16px
    use: Tab / filter chip
    active: '#65a4f4 text + 1px #65a4f4 border'
  link:
    type: badge
    textColor: '#0066cc'
    use: Utilitarian database-link blue, no underline until hover
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 6px
    use: 'White surface, 1px #dddddd hairline, soft neutral shadow'
  stat-figure:
    type: badge
    textColor: '#fa3e3e'
    typography: weight 300, 32px
    use: Large spreadsheet-style numeric stats
fonts:
  roles:
    sans: Open Sans
    cjk: Noto Sans TC
---

# Ragic

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ragic; reproduced for educational reference. Full prose: https://oh-my-design.kr/ragic/design.md
