---
name: SmartNews
colors:
  primary: '#EB0B22'
  brand: '#EB0B22'
  canvas: '#FFFFFF'
  foreground: '#000000'
  muted: '#666666'
  on-primary: '#FFFFFF'
  surface: '#F5F5F5'
typography:
  headline:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.3
    use: Bold scannable article headlines
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Article preview / body text
  meta:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Source name, timestamp, channel labels
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
components:
  tab-channel:
    type: tab
    backgroundColor: '#FFFFFF'
    textColor: '#666666'
    active: 'text #000000 bold, #EB0B22 underline bar'
    use: Swipeable channel bar — core navigation
  button-primary:
    type: button
    backgroundColor: '#EB0B22'
    textColor: '#FFFFFF'
    rounded: 8px
    use: Key conversion action (Get the app, Subscribe)
  button-secondary:
    type: button
    backgroundColor: '#FFFFFF'
    textColor: '#000000'
    border: 1px solid neutral
    rounded: 8px
    use: Lower-emphasis action
  button-download:
    type: button
    backgroundColor: '#000000'
    textColor: '#FFFFFF'
    rounded: 12px
    typography: / 700
    use: App Store / Google Play download tile
  card-article:
    type: card
    backgroundColor: '#FFFFFF'
    textColor: '#000000'
    rounded: 8px
    use: Headline + source + timestamp + thumbnail feed unit
  card-image:
    type: card
    textColor: '#FFFFFF'
    use: Featured story — photo fill, white headline over dark scrim
  badge-breaking:
    type: badge
    backgroundColor: '#EB0B22'
    textColor: '#FFFFFF'
    rounded: 4px
    typography: / 700
    use: Breaking / live emphasis, uppercase
fonts:
  roles:
    sans: system-ui
    mono: system-ui
---

# SmartNews

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SmartNews; reproduced for educational reference. Full prose: https://oh-my-design.kr/smartnews/design.md
