---
name: Apple
colors:
  primary: '#0071e3'
  brand: '#000000'
  canvas: '#f5f5f7'
  canvas-dark: '#000000'
  surface: '#ffffff'
  foreground: '#1d1d1f'
  on-primary: '#ffffff'
  muted: '#6e6e73'
  secondary: '#515154'
  link: '#0066cc'
  link-on-dark: '#2997ff'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 600
    lineHeight: 60px
    letterSpacing: '-0.28px'
  section:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 44px
  tile-heading:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 32px
    letterSpacing: 0.196px
  body:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 25px
    letterSpacing: '-0.374px'
  body-small:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 18.0008px
    letterSpacing: '-0.224px'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16.0005px
    letterSpacing: '-0.12px'
rounded:
  control: 8px
  docs-card: 18px
  marketing-pill: 980px
spacing:
  compact: 8
  control-inline: 15
  pill-block: 11
  pill-inline: 21
  content: 20
components:
  marketing-primary:
    type: button
    backgroundColor: '#0071e3'
    textColor: '#ffffff'
    rounded: 980px
    padding: 11px 21px
    height: 44px
    typography: 17px / 400
    hover: '#0076df'
    pressed: '#006edb'
    focus: '0 0 0 2px #0071e3 outline'
    states: hover, pressed and keyboard focus re-measured live 2026-09-17; the focus ring is the brand blue, not a user-agent default
    use: large apple.com marketing CTA
  marketing-outline:
    type: button
    backgroundColor: transparent
    textColor: '#0066cc'
    border: '1px solid #0066cc'
    rounded: 980px
    padding: 11px 21px
    height: 44px
    typography: 17px / 400
    states: default captured; hover not retained
    use: secondary apple.com marketing CTA
  marketing-compact:
    type: button
    backgroundColor: '#0071e3'
    textColor: '#ffffff'
    rounded: 980px
    padding: 8px 15px
    height: 36px
    typography: 14px / 400
    states: default captured; hover not retained
    use: compact apple.com tile CTA
  product-gallery-tab:
    type: tab
    textColor: '#1d1d1f'
    height: 53px
    typography: 17px / 400
    states: selected and unselected gallery thumbnails
    use: Apple Store product image selection
  hig-reference-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 18px
    states: default documentation card; hover not retained
    use: HIG documentation index card, not a native-platform component token
fonts:
  roles:
    display: SF Pro Display
    text: SF Pro Text
---

# Apple

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Apple; reproduced for educational reference. Full prose: https://oh-my-design.kr/apple/design.md
