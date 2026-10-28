---
name: mikan
colors:
  primary: '#ff4c0a'
  marigold: '#fd9b12'
  accent-orange: '#ff7f09'
  orange-shadow: '#e26f00'
  navy: '#001c46'
  ink: '#000e22'
  text: '#333333'
  canvas: '#ffffff'
  surface: '#f7f4f3'
  surface-grey: '#fafafa'
  surface-alt: '#f9f9f9'
  hairline: '#eeeeee'
  muted: '#666666'
  on-primary: '#ffffff'
typography:
  hero:
    fontSize: 36px
    fontWeight: 900
    lineHeight: 1.4
    use: Corporate hero copy, Hiragino weight 900
  section:
    fontSize: 60px
    fontWeight: 900
    use: Large English section labels (Service), brand orange
  section-jp:
    fontSize: 36px
    fontWeight: 900
    use: Japanese section headings, brand orange
  school-h2:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: mikan for School section titles, Noto Sans 700
  school-h3:
    fontSize: 24px
    fontWeight: 700
    use: School feature sub-heads, Noto Sans JP 700
  step-num:
    fontSize: 46px
    fontWeight: 600
    use: Step numerals 01/02/03, Oswald, marigold
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
    use: Standard reading text
  nav:
    fontSize: 16px
    fontWeight: 700
    use: Top nav links, weight 700
  button:
    fontSize: 15px
    fontWeight: 700
    use: Corporate CTA label
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  xl: 20px
  full: 320px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 30
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#ff4c0a'
    textColor: '#ffffff'
    rounded: 6px
    padding: 15px 30px
    height: 48px
    typography: 15px / 700
    use: Corporate CTA — 採用情報 / View More
  button-school-fill:
    type: button
    backgroundColor: '#ff7f09'
    textColor: '#ffffff'
    rounded: 8px
    padding: 17px 30px
    height: 61px
    shadow: '#e26f00 0px 4px 0px 0px'
    typography: 16px / 400
    use: mikan for School primary — 無料トライアルのお申し込み, 3D hard-shadow
  button-school-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '2px solid #ff7f09'
    rounded: 8px
    padding: 17px 30px
    height: 65px
    shadow: '#e26f00 0px 4px 0px 0px'
    typography: 16px / 400
    use: School secondary — 資料請求する
  button-download:
    type: button
    backgroundColor: '#fd9b12'
    textColor: '#ffffff'
    rounded: 4px
    height: 44px
    typography: 15px / 400
    use: School 資料ダウンロード marigold pill
  news-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 10px
    padding: 20px
    use: News / お知らせ list card, flat
  job-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 12px
    padding: 20px
    use: Careers posting card 🍊
  review-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 8px
    use: Note interview / review card
  nav-link:
    type: tab
    textColor: '#333333'
    typography: 16px / 700
    use: Top nav item (Top / About / Members)
    active: 'brand orange #ff4c0a text on active'
  step-badge:
    type: badge
    textColor: '#fd9b12'
    typography: 46px / 600 Oswald
    use: Step numeral 01/02/03 on School
fonts:
  roles:
    display: Hiragino Kaku Gothic ProN
    body: Noto Sans JP
    numeral: Oswald
---

# mikan

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to mikan; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/mikan/DESIGN.md
