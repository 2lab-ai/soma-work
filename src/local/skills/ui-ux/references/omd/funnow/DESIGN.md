---
name: FunNow
colors:
  primary: '#ff5537'
  teal: '#4dcbcb'
  flash-indigo: '#5a69eb'
  amber: '#ffb107'
  ink: '#252729'
  ink-pure: '#000000'
  muted: '#a7a7a9'
  canvas: '#f4f4f5'
  surface: '#ffffff'
  tint-peach: '#ffd8d1'
  tint-blush: '#ffeeeb'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.22
    use: Hero H1 headline on homepage
  page-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: Category / listing page H1
  section:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Category page H2 intro
  subtitle:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.41
    use: Hero H2 subtitle, section heads, filter tabs
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, header buttons
  button:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1
    use: Primary CTA / control labels
  badge:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.3
    use: Urgency and flash-sale tags
rounded:
  sm: 4px
  md: 5px
spacing:
  xs: 2
  sm: 8
  md: 12
  base: 16
components:
  button-primary:
    type: button
    backgroundColor: '#ff5537'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 16px
    height: 40px
    typography: 14px / 400
    use: Search submit / primary CTA — the single solid-fill button on the page
  button-outline-teal:
    type: button
    textColor: '#4dcbcb'
    border: '1px solid #4dcbcb'
    rounded: 4px
    padding: 0px 8px
    height: 36px
    typography: 15px / 400
    use: Download App header CTA, outlined teal
  button-text:
    type: button
    textColor: '#000000'
    rounded: 4px
    padding: 0px 8px
    height: 36px
    typography: 15px / 400
    use: Login / Sign Up quiet header action
  badge-available-now:
    type: badge
    backgroundColor: '#ff5537'
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 8px
    typography: 12px / 500
    use: '''Available now'' urgency tag on product cards'
  badge-flash-sale:
    type: badge
    backgroundColor: '#5a69eb'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 8px
    typography: 12px / 400
    use: '''Flash Sales Now'' / timed-deal countdown tag'
  card-product:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    use: 'Flat v-card product tile sitting on the #f4f4f5 canvas, image-led, no shadow'
  tab-filter:
    type: tab
    textColor: '#252729'
    active: 'text #ff5537'
    height: 48px
    typography: 17px / 400
    use: Category scope tabs (All / Beitou Hot Spring Hotel / ...)
  input-search:
    type: input
    textColor: '#000000'
    rounded: 0px
    padding: 8px 16px
    height: 40px
    typography: 16px / 400
    use: Hero search field inside the white booking toolbar
fonts:
  roles:
    sans: Helvetica Neue
    tc: PingFang TC, Microsoft JhengHei
---

# FunNow

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to FunNow; reproduced for educational reference. Full prose: https://oh-my-design.kr/funnow/design.md
