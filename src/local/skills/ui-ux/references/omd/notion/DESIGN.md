---
name: Notion
colors:
  primary: '#0075de'
  primary-hover: '#005bab'
  canvas: '#ffffff'
  ink: '#000000'
  muted: '#615d59'
  docs-layer: '#f9f9f8'
typography:
  hero:
    fontSize: 96px
    fontWeight: 600
    lineHeight: 100
    letterSpacing: '-4.6px'
    use: Observed marketing h1 at the captured viewport
  heading:
    fontSize: 54px
    fontWeight: 700
    lineHeight: 56
    letterSpacing: '-1.875px'
    use: Observed public marketing/product h2
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24
    use: Observed navigation, cards, and Help chrome
  action:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24
    use: Observed public marketing CTA
  label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20
    use: Observed menu trigger and Help dialog control
rounded:
  docs-input: 5px
  control: 8px
  card: 12px
  pill: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 24
components:
  marketing-primary-action:
    type: button
    backgroundColor: '#0075de'
    textColor: '#ffffff'
    rounded: 8px
    padding: 4px 14px
    height: 36
    typography: 16px/500 NotionInter
    states: hover/pressed/focus captured on marketing; values remain selector-specific
    use: Global marketing CTA
    hover: '#005bab'
    pressed: '#005bab'
    focus: '#005bab'
  help-search:
    type: input
    textColor: '#000000'
    border: 1px solid rgba(0,0,0,0.08)
    rounded: 5px
    padding: 7px 10px 7px 30px
    height: 36
    typography: 16px/400 NotionInter
    states: dialog-open focus style captured
    use: Help language-picker search field
fonts:
  roles:
    sans: NotionInter
---

# Notion

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Notion; reproduced for educational reference. Full prose: https://oh-my-design.kr/notion/design.md
