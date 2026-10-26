---
name: Bilibili
colors:
  canvas: '#f1f2f3'
  surface: '#ffffff'
  foreground: '#18191c'
  muted: '#9499a0'
  secondary: '#61666d'
  hairline: '#e3e5e7'
typography:
  nav-label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 64
    use: Product-home header entry links
  video-title:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 22
    use: Home video-card title
  metadata:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 17
    use: Home video-card owner and date
rounded:
  sm: 4px
  md: 6px
spacing:
  xs: 4
  sm: 8
  md: 16
components:
  video-card-cover:
    type: card
    backgroundColor: '#f1f2f3'
    rounded: 6px
    use: Product-home video-card cover wrapper; 248px × 140px in the captured desktop viewport
  video-card-stats:
    type: badge
    textColor: '#ffffff'
    rounded: 0px 0px 6px 6px
    padding: 16px 8px 6px
    typography: 13px / 400
    use: Product-home video-card statistics strip
  skeleton-line:
    type: card
    backgroundColor: '#f1f2f3'
    rounded: 4px
    use: Product-home video-card loading text line
fonts:
  roles:
    sans: '-apple-system'
---

# Bilibili

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bilibili; reproduced for educational reference. Full prose: https://oh-my-design.kr/bilibili/design.md
