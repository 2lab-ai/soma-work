---
name: VoltAgent
colors:
  primary: '#00d992'
  mint: '#2fd6a1'
  emerald: '#10b981'
  purple: '#818cf8'
  cobalt: '#306cce'
  canvas: '#050507'
  surface: '#101010'
  border: '#3d3a39'
  text: '#f2f2f2'
  on-primary: '#ffffff'
  body: '#b8b3b0'
  muted: '#8b949e'
  success: '#008b00'
  warning: '#ffba00'
  danger: '#fb565b'
  info: '#4cb3d4'
typography:
  display:
    fontSize: 60px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.65px'
    use: Hero, compressed blocks
  section:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1.11
    letterSpacing: '-0.9px'
    use: Section headings
  subheading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.6px'
    use: Bold emphasis sub-heads
  overline:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.5px
    use: Uppercase section labels
  feature:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.4
    use: Card headings, feature names
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body, nav links, buttons
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Descriptions, metadata, badges
  micro:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Smallest sans text
  code:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Inline code, terminal output
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
  xl: 32
  xxl: 48
  section: 64
components:
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 6px
    padding: 12px 16px
    use: 'Default interactive; 1px #3d3a39 border'
  button-primary:
    type: button
    backgroundColor: '#101010'
    textColor: '#2fd6a1'
    rounded: 6px
    padding: 12px 16px
    use: Powered-on CTA; mint text on dark, mint outline
  button-container:
    type: button
    backgroundColor: '#101010'
    textColor: '#f2f2f2'
    rounded: 8px
    padding: 20px
    use: 'Card-like button for larger surfaces; 3px #3d3a39 border'
  card:
    type: card
    backgroundColor: '#101010'
    textColor: '#f2f2f2'
    rounded: 8px
    use: 'Content card; 1px #3d3a39 border, 2px #00d992 if active; haze shadow'
  input:
    type: input
    backgroundColor: '#101010'
    textColor: '#f2f2f2'
    use: 'Inferred; #3d3a39 border, mint focus ring'
  nav:
    type: tab
    backgroundColor: '#050507'
    textColor: '#f2f2f2'
    typography: 14px/500
    use: Sticky top nav; links shift green on hover
fonts:
  roles:
    sans: system-ui
    mono: SFMono-Regular
---

# VoltAgent

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to VoltAgent; reproduced for educational reference. Full prose: https://oh-my-design.kr/voltagent/design.md
