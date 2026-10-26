---
name: E.SUN Bank
colors:
  primary: '#00a19b'
  primary-deep: '#007a7a'
  ink: '#1c1c1c'
  muted: '#7c7c7c'
  muted-alt: '#999999'
  canvas: '#ffffff'
  surface: '#f4f8fa'
  surface-alt: '#f5f5f5'
  teal-tint: '#d0e6e6'
  on-primary: '#ffffff'
  hairline: '#d9d9d9'
  error: '#c92e34'
typography:
  display-hero:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.4
    use: Hero ESG / campaign headlines, bold declaration
  section:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.5
    use: Section headings (外幣匯率, 最新消息, 探索數位服務)
  subsection:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.5
    use: Feature card sub-headings, product intros
  page-title:
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.5
    use: Product category page titles (信用卡/支付)
  nav:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Top-tier nav labels
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body text and UI labels
  button:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: CTA button labels
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 20
  lg: 24
  xl: 30
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#00a19b'
    textColor: '#ffffff'
    rounded: 4px
    padding: 10px
    height: 46px
    typography: 16px / 400
    border: '1px solid #00a19b'
    use: Primary CTA — 線上開戶 (open account)
  button-ghost:
    type: button
    textColor: '#00a19b'
    rounded: 4px
    padding: 8px 20px
    typography: 20px / 400
    border: '1px solid #00a19b'
    use: Hero ghost link — 線上開戶 secondary variant in hero
  button-return:
    type: button
    backgroundColor: '#00a19b'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 50px
    height: 65px
    typography: 16px / 400
    use: Large return-to-home CTA on error/404 pages
  nav-tab:
    type: tab
    textColor: '#7c7c7c'
    typography: 14px / 400 Noto Sans TC
    use: Top-tier nav (企業/商家, 私銀/亞資, ESG 永續金融)
    active: 'text #00a19b weight 500'
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    shadow: rgb(208, 230, 230) 0px 0px 12px 0px
    use: Activity/news card, teal-tinted ambient shadow
  card-table:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    shadow: rgb(208, 230, 230) 0px 0px 12px 0px
    use: Exchange-rate table container
  card-service:
    type: card
    backgroundColor: rgba(0, 0, 0, 0)
    rounded: 4px
    border: '1px solid #ffffff'
    use: Hero CTA service item cards on teal background
  badge-section:
    type: badge
    textColor: '#00a19b'
    rounded: 0px
    typography: 32px / 500
    use: Section heading text label (非图形 badge pattern)
  input-search:
    type: input
    backgroundColor: '#ffffff'
    border: '1px solid #d9d9d9'
    rounded: 4px
    typography: 16px / 400 Noto Sans TC
    use: Search / form inputs on white surface
fonts:
  roles:
    display: Noto Sans TC
    ui: Microsoft JhengHei
    fallback: Arial, sans-serif
---

# E.SUN Bank

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to E.SUN Bank; reproduced for educational reference. Full prose: https://oh-my-design.kr/esunbank/design.md
