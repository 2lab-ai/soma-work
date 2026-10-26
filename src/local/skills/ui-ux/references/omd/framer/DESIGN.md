---
name: Framer
colors:
  canvas: '#000000'
  foreground: '#ffffff'
  muted: '#999999'
  marketplace-surface: '#242424'
  accent: '#0099ff'
typography:
  public-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 14
    letterSpacing: '-0.01px'
    use: Observed public-home body text
rounded:
  compact: 8px
  menu: 13px
  category-card: 20px
spacing:
  compact-x: 10
  menu-inset: 5
components:
  marketplace-filter:
    type: button
    backgroundColor: '#242424'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 10px
    typography: 12px / 500
    states: expanded and menu-open captured on the Marketplace filter
    use: Marketplace filter trigger on the public community surface
  marketplace-category:
    type: card
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 20px
    use: Marketplace category card on the public community surface
fonts:
  roles:
    ui: Inter
    display: GT Walsheim Medium
---

# Framer

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Framer; reproduced for educational reference. Full prose: https://oh-my-design.kr/framer/design.md
