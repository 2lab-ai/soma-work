---
name: Timee
colors:
  primary: '#ffd700'
  ink: '#212121'
  canvas: '#ffffff'
  action-blue: '#007aff'
  blue-shadow: '#0054af'
  alert: '#ff3b30'
  surface-inactive: '#eaeaea'
  neutral: '#b7b8bc'
  surface-business: '#f5f5f4'
  muted: '#666666'
  faint: '#999999'
  on-primary: '#212121'
typography:
  section:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: Homepage section headlines (H2)
  section-biz:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.2
    use: Business LP section headlines (H2)
  subsection:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Feature heads, app-download head (H3)
  button-lg:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Large CTA labels, filter pills
  category:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    use: Job-category titles, anchor links
  card-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Job-card titles
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  button-sm:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.5
    use: Header pill button label
  badge:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.5
    use: NEW!! sticker badge
rounded:
  md: 16px
  lg: 25px
  xl: 48px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 20
  xl: 24
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#ffd700'
    textColor: '#212121'
    border: '2px solid #212121'
    rounded: 9999px
    padding: 24px 20px
    height: 82px
    typography: 20px / 700
    shadow: '0px 8px 0px 0px #212121'
    use: Brand-yellow hero CTA (企業様向けページはこちら) — outlined pill with hard offset shadow
  button-app-cta:
    type: button
    backgroundColor: '#007aff'
    textColor: '#ffffff'
    rounded: 9999px
    height: 89px
    typography: 16px / 400
    shadow: '0px 8px 0px 0px #0054af'
    use: App-install CTA on worker homepage, hard blue offset shadow
  button-business:
    type: button
    backgroundColor: '#007aff'
    textColor: '#ffffff'
    border: '2px solid #007aff'
    rounded: 9999px
    padding: 4px 16px 6px
    height: 38px
    typography: 16px / 700
    use: B2B primary CTA (アカウント開設) on business LP
  button-business-ghost:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#007aff'
    border: '2px solid #007aff'
    rounded: 9999px
    padding: 4px 16px 6px
    height: 38px
    typography: 16px / 700
    use: B2B secondary CTA (資料ダウンロード)
  tab-age-filter:
    type: tab
    backgroundColor: '#eaeaea'
    textColor: '#212121'
    border: '1px solid #212121'
    rounded: 999px
    height: 42px
    typography: 20px / 700
    active: 'bg #212121 + text #ffffff'
    use: Worker-data age filter pills (18歳〜/20代/30代…)
  badge-new:
    type: badge
    backgroundColor: '#212121'
    textColor: '#ffd700'
    rounded: 99px
    typography: 12px / 700
    use: Circular NEW!! sticker, yellow-on-ink
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#212121'
    rounded: 25px
    use: Feature explainer card (単発で働ける/即日振り込み) on tinted section
  dialog-qr:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 16px
    shadow: 0px 8px 32px 0px rgba(0,0,0,0.24)
    use: QR app-download modal
fonts:
  roles:
    sans: Noto Sans JP
---

# Timee

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Timee; reproduced for educational reference. Full prose: https://oh-my-design.kr/timee/design.md
