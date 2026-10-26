---
name: SPEEDA (Uzabase)
colors:
  primary: '#e60f3d'
  primary-deep: '#d30030'
  accent: '#f72a48'
  tint: '#ffe8e8'
  ink: '#191919'
  ink-strong: '#000000'
  body: '#282828'
  muted: '#6f6f6f'
  faint: '#a5a5a5'
  canvas: '#ffffff'
  surface: '#f5f5f5'
  surface-alt: '#ededed'
  hairline: '#cbcbcb'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.96px
    use: Hero H1, Shorai Sans demi
  section:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.4
    use: H3 feature heads, Shorai Sans
  body:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, Shorai Sans
  nav:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Top nav items, Shorai Sans
  button:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: CTA pill label, Shorai Sans
rounded:
  sm: 10px
  md: 12px
  lg: 17px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 10
  base: 18
  lg: 20
  xl: 40
  xxl: 72
  section: 92
components:
  cta-primary:
    type: button
    backgroundColor: '#e60f3d'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 10px 18px
    height: 44px
    typography: 16px / 400 Shorai Sans
    use: Primary download CTA (資料ダウンロード), full pill
  cta-trial:
    type: button
    backgroundColor: '#ffe8e8'
    textColor: '#d30030'
    rounded: 9999px
    padding: 10px 18px
    height: 44px
    typography: 16px / 400 Shorai Sans
    use: Soft-tint trial CTA (無料トライアル)
  nav-link:
    type: tab
    textColor: '#191919'
    typography: 14px / 400 Shorai Sans
    active: 'accent #f72a48 text on active'
    use: Top nav item (ソリューション, 導入事例)
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    padding: 37px 40px
    use: White feature card, hairline-separated, no shadow
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 40px 72px 72px
    use: Large feature panel
  input-text:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #cbcbcb'
    rounded: 10px
    textColor: '#191919'
    use: 'Form input, hairline border, placeholder #a5a5a5'
  badge-accent:
    type: badge
    backgroundColor: '#ffe8e8'
    textColor: '#d30030'
    rounded: 9999px
    typography: 13px / 400 Shorai Sans
    use: Status / emphasis pill
fonts:
  roles:
    sans: Shorai Sans StdN Demi
---

# SPEEDA (Uzabase)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SPEEDA (Uzabase); reproduced for educational reference. Full prose: https://oh-my-design.kr/speeda/design.md
