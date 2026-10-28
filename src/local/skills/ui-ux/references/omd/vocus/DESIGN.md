---
name: Vocus
colors:
  primary: '#ff485a'
  ink: '#141413'
  ink-pure: '#000000'
  body: '#535150'
  muted: '#7a7574'
  faint: '#a29c9b'
  accent-link: '#00b3c6'
  canvas: '#ffffff'
  surface: '#f6f6f6'
  surface-alt: '#f2f1f0'
  surface-faint: '#f7f7f7'
  hairline: '#ddd9d8'
  on-primary: '#ffffff'
typography:
  spark-hero:
    fontSize: 80px
    fontWeight: 700
    lineHeight: 1.36
    use: Brand spark hero 'Where the Sparks Begin', Noto Sans TC Bold
  section:
    fontSize: 42px
    fontWeight: 700
    lineHeight: 1.45
    use: Landing section titles, Noto Sans TC Bold
  article-h1:
    fontSize: 42px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1px
    use: Article title, Noto Sans TC Bold
  article-h2:
    fontSize: 34px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1.7px
    use: Article H2, Noto Sans TC Bold
  feature-h3:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.43
    use: Feature-card heads, Noto Sans TC Bold
  article-h3:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1.2px
    use: Article H3, Noto Sans TC Bold
  reading-body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.9
    letterSpacing: 0.9px
    use: Long-form article body, Noto Sans TC — generous CJK reading rhythm
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Article-shell nav items, Noto Sans TC
  ui:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Default UI / chrome text, Noto Sans TC
rounded:
  sm: 6px
  md: 8px
  lg: 16px
  pill: 14px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#ff485a'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 12px
    height: 36px
    typography: 14px / 500 Noto Sans TC
    use: Register/login CTA — the single coral action
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#141413'
    border: '4px solid #141413'
    rounded: 16px
    padding: 15px 24px
    height: 60px
    typography: 18px / 500 Noto Sans TC
    use: Hero 'sign up now' bold-outline CTA
  button-menu:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#141413'
    rounded: 8px
    padding: 10px 12px
    height: 36px
    typography: 14px / 500 Noto Sans TC
    use: Nav dropdown trigger
  feature-tab:
    type: tab
    textColor: '#141413'
    rounded: 6px
    typography: 12.25px / 500 Noto Sans TC
    active: 'text #141413 + 2px bottom border #ff485a'
    use: Feature-card category tabs
  partner-badge:
    type: badge
    backgroundColor: '#f6f6f6'
    textColor: '#7a7574'
    rounded: 14px
    padding: 2px 8px
    typography: 14px / 400 Noto Sans TC
    use: Creator partner / status pill (格命夥伴)
  tag-link:
    type: badge
    textColor: '#a29c9b'
    typography: 16px / 400 Noto Sans TC
    use: Hashtag topic tag (#投資策略)
  article-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#141413'
    rounded: 16px
    use: 'Article / feature card on warm-grey surface, 1px #ddd9d8 hairline'
  nav-link:
    type: listItem
    textColor: '#535150'
    typography: 16px / 400 Noto Sans TC
    use: Article-shell nav item (首頁 / 方格誌 / 格友大廳)
fonts:
  roles:
    sans: Noto Sans TC
---

# Vocus

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Vocus; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/vocus/DESIGN.md
