---
name: Greenvines
colors:
  primary: '#002d18'
  accent: '#c84600'
  canvas: '#ffffff'
  sage: '#9caba3'
  sage-pale: '#e6eae8'
  sage-button: '#ced5d1'
  green-soft: '#3b5647'
  ink-alt: '#0a2d1b'
  stepper-grey: '#f1f1f1'
  footer-heading: '#9b9b9b'
  footer-muted: '#aaaaaa'
  helper-grey: '#666464'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 104px
    fontWeight: 100
    lineHeight: 1.1
    letterSpacing: 2px
    use: Page-title hero (品牌故事, brand name)
  display:
    fontSize: 52px
    fontWeight: 100
    lineHeight: 1.23
    letterSpacing: 2px
    use: Section headlines, homepage H2/H3
  heading:
    fontSize: 45px
    fontWeight: 100
    lineHeight: 1.25
    letterSpacing: 2px
    use: Product-page section H2
  subheading:
    fontSize: 30px
    fontWeight: 100
    lineHeight: 1.3
    letterSpacing: 2px
    use: Sub-section heads, story links
  card-title:
    fontSize: 28px
    fontWeight: 100
    lineHeight: 1.36
    use: Overlay card titles on photography
  body-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    use: Brand-story paragraphs
  nav:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 1.2
    use: Mega-menu product links
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Standard body text, buttons
  button:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 1px
    use: Outline / fill CTA labels
  footer-head:
    fontSize: 15px
    fontWeight: 100
    lineHeight: 2.4
    use: Footer column headings
rounded:
  none: 0px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 15
  lg: 20
  xl: 32
  xxl: 50
  section: 80
components:
  button-outline:
    type: button
    textColor: '#002d18'
    border: '2px solid #002d18'
    rounded: 0px
    padding: 12px 20px
    height: 48px
    typography: 14px / 400
    states: letter-spacing 1px, arrow suffix →
    use: Default CTA — 深入了解, 閱讀文章, 純淨保養組合
  button-accent:
    type: button
    backgroundColor: '#c84600'
    textColor: '#ffffff'
    border: '2px solid #c84600'
    rounded: 0px
    padding: 12px 20px
    height: 48px
    typography: 14px / 400
    use: Emphasis CTA — sustainability 深入了解 blocks, promo links
  button-cart:
    type: button
    backgroundColor: '#c84600'
    textColor: '#ffffff'
    rounded: 0px
    padding: 12px 20px
    height: 80px
    typography: 20px / 600
    use: 加入購物車 add-to-cart bar on product pages
  button-stepper:
    type: button
    backgroundColor: '#f1f1f1'
    textColor: '#0a2d1b'
    rounded: 0px
    height: 80px
    typography: 20px / 400
    use: Quantity +/− stepper flanking add-to-cart
  button-newsletter:
    type: button
    backgroundColor: '#ced5d1'
    textColor: '#002d18'
    rounded: 0px
    height: 50px
    typography: 16px / 400
    use: Newsletter submit on footer dark panel
  input-newsletter:
    type: input
    textColor: '#ffffff'
    rounded: 0px
    height: 55px
    typography: 14px / 400
    use: 'Newsletter name/email field on #002d18 footer, translucent #e6eae8-tinted fill'
  card-sage:
    type: card
    backgroundColor: '#9caba3'
    textColor: '#002d18'
    rounded: 0px
    use: Sage-green tinted section surface / content band
  footer-link:
    type: listItem
    textColor: '#ffffff'
    typography: 15px / 400
    use: 'Footer navigation link on #002d18 (品牌故事, 永續報告書)'
fonts:
  roles:
    display: gv (custom webfont)
    fallback: Noto Sans TC / 微軟正黑體
    base: Helvetica Neue
---

# Greenvines

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Greenvines; reproduced for educational reference. Full prose: https://oh-my-design.kr/greenvines/design.md
