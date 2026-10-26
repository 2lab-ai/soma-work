---
name: VUNO
colors:
  primary: '#40e2de'
  on-primary: '#102135'
  primary-sweep: '#b4fffd'
  navy: '#102135'
  navy-deep: '#0c1a29'
  navy-band: '#18314d'
  surface: '#f7f7f7'
  white: '#ffffff'
  on-dark: '#d7dfe6'
  muted: '#9bacbb'
  black: '#000000'
  secondary: '#555555'
  caption: '#707070'
  charcoal: '#222222'
  hairline: '#dddddd'
typography:
  display-hero:
    fontSize: 60px
    fontWeight: 600
    lineHeight: 1.4
    use: 'Home hero statement (의료인공지능의 미래, 뷰노가 이끌어갑니다.) in #ffffff, 84px line; Korean glyphs fall through Poppins to the NanumSquare face'
  section:
    fontSize: 50px
    fontWeight: 600
    lineHeight: 1.36
    use: 'Section headings on home (주요 소식 in #ffffff; the heading above the logo grid in #000000), 68px line'
  contact-title:
    fontSize: 50px
    fontWeight: 600
    lineHeight: 1.6
    use: 'Closing contact heading on every page (뷰노메드 솔루션에 대해 더 궁금하신가요?), #ffffff, 80px line'
  menu:
    fontSize: 45px
    fontWeight: 500
    lineHeight: 1.15
    use: First-level items of the full-screen menu layer (About VUNO, Products, News ...), 51.75px line
  section-sm:
    fontSize: 35px
    fontWeight: 600
    lineHeight: 1.1
    use: '관련 뉴스 heading on the DeepCARS page, #000000, 38.5px line'
  card-title-lg:
    fontSize: 29px
    fontWeight: 500
    lineHeight: 1.15
    use: 'Product slide titles in the home Products carousel, #ffffff, 33.35px line'
  lead:
    fontSize: 24px
    fontWeight: 300
    lineHeight: 1.67
    use: 'Product descriptions on home and the DeepCARS hero, #ffffff, 40.08px line (39.6px on DeepCARS)'
  body-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.75
    use: 'Slide descriptions in the home Products carousel, #d7dfe6, 35px line'
  copy:
    fontSize: 20px
    fontWeight: 300
    lineHeight: 1.67
    use: 'Feature copy under the DeepCARS point headings, #ffffff, 33.4px line'
  tab:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.15
    use: 'Product tabs on home (#d7dfe6, the current tab #40e2de), 23px line'
  card-title:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Press card titles, #000000, 30px line'
  nav:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.15
    use: 'Header navigation links, #ffffff, the current section #40e2de, 20.7px line'
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Call-to-action labels (문의사항 남기기, 더 알아보기), 22.4px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.15
    use: Document default on all three pages, Poppins then NANUMSQUARE-400, 18.4px line
  eyebrow:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.6
    use: 'Icon-led product label above the DeepCARS hero copy, #40e2de, 24px line'
  link-sm:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.4
    use: '모든 소식 보기 arrow link, #d7dfe6 on home (600 weight in #102135 on the DeepCARS #f7f7f7 band), 21px line'
  footer:
    fontSize: 15px
    fontWeight: 300
    lineHeight: 1.15
    use: Footer menu items, muted blue-grey at 75% alpha, 17.25px line
  tag:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: 'Press card category and hashtag labels, #555555, 22px line'
  breadcrumb:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.18
    use: 'Breadcrumb trail on /about and /deepcars, #9bacbb, 15.34px line'
rounded:
  none: 0px
spacing:
  cta-x: 8
  tag-x: 6
  row-y: 60
  row-left: 22
  arrow-right: 40
  article-x: 90
  dialog: 30
components:
  filled-button:
    type: button
    backgroundColor: '#40e2de'
    textColor: '#102135'
    rounded: 0px
    padding: 0px 8px
    height: 60px
    typography: 16px / 600 / 22.4px Poppins
    hover: 'a #b4fffd sheet (::after, 325 x 60, skewed) slides across the teal fill; the label stays #102135'
    pressed: same as hover
    states: 'the fill is the ::before layer (250 x 60, bg #40e2de); the button''s own background is transparent; hover and pressed move the ::after from matrix(1, 0, -1, 1, -325, 0) to matrix(1, 0, -1, 1, 0, 0) under transition all 0.2s linear; focus not measured'
    use: '더 알아보기 in the home VUNO Med Solution section at home::[data-omd-capture="34"] (250 x 60, on #102135) and 문의사항 남기기 in the DeepCARS closing band (on #18314d)'
  outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#40e2de'
    border: '1px solid #40e2de (::before layer)'
    rounded: 0px
    padding: 0px 8px
    height: 60px
    typography: 16px / 600 / 22.4px Poppins (400 on the DeepCARS hero instance)
    hover: 'a #40e2de sheet (::after, skewed) slides in; label turns #102135'
    pressed: same as hover
    states: hover and pressed settle after transition all 0.2s linear (probe on home and /deepcars); focus not measured
    use: '문의사항 남기기 in the closing contact band of all three pages at home::[data-omd-capture="39"] (250 x 60, on #0c1a29) and in the DeepCARS hero'
  arrow-link:
    type: button
    textColor: '#d7dfe6'
    padding: 6px 40px 5px 0px
    height: 32px
    typography: 15px / 500 / 21px Poppins
    icon: 30 x 30 ::after box with a 1px border in the label colour and an arrow image
    states: hover and pressed show no change across the link, its pseudo-elements and three ancestor levels
    use: '모든 소식 보기 beside 주요 소식 on home (#d7dfe6; the ground behind it was not revealed when the probe read it) and beside 관련 뉴스 on /deepcars (#102135, 15px / 600, on #f7f7f7)'
  nav-link:
    type: tab
    textColor: '#ffffff'
    height: 100px
    typography: 18px / 400 / 20.7px Poppins
    selected: 'fg #40e2de on the current section (About VUNO on /about, Products on /deepcars)'
    states: selected variant read from rest values on three pages; no pointer frame measured
    use: Header navigation (About VUNO, Products, News, IR, Publications, Career) at home::[data-omd-capture="1"], 110 x 100 cells
  lang-toggle:
    type: tab
    textColor: '#9bacbb'
    padding: 0px 8px
    typography: 16px / 500 / 18.4px Poppins
    selected: 'fg #ffffff on the current language (KR)'
    states: rest values only
    use: KR / EN switch in the header at home::[data-omd-capture="8"]
  product-tab:
    type: tab
    textColor: '#d7dfe6'
    padding: 0px 0px 0px 37px
    typography: 20px / 400 / 23px Poppins
    selected: 'fg #40e2de on the current tab (li.tab.on)'
    states: rest values only
    use: Product tabs beside the home Products carousel (VUNO Med-Chest X-ray, Fundus AI, DeepCARS, VUNO Care-HATIV), 384 x 23
  news-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '2px solid #40e2de on the top edge only'
    rounded: 0px
    size: 399px x 581px
    use: Press cards in the 주요 소식 carousel on home (three visible) and 관련 뉴스 on /deepcars; every captured card carries the teal top rule
  tag:
    type: badge
    textColor: '#555555'
    border: '1px solid #dddddd'
    rounded: 0px
    padding: 0px 6px
    height: 26px
    typography: 14px / 400 / 22px Poppins
    use: 'Hashtag labels (#announcement, #pressrelease) at the foot of press cards'
  solution-row:
    type: card
    border: 1px solid rgba(255, 255, 255, 0.2) on the top edge
    padding: 60px 8px 60px 22px
    size: 758px x 301px
    use: Numbered data-domain rows on home (01 Medical Imaging, 02 Pathology, 03 Biosignals, 04 Speech) in white text; the ground behind them was not measured
  cookie-dialog:
    type: dialog
    backgroundColor: rgba(255, 255, 255, 0.93)
    textColor: '#000000'
    padding: 30px
    size: 420px x 234px
    use: Cookie notice open at capture on all three pages; its only button accepts, so the collector left it open and nothing was pressed
fonts:
  roles:
    latin: Poppins
    korean: NANUMSQUARE
---

# VUNO

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to VUNO; reproduced for educational reference. Full prose: https://oh-my-design.kr/vuno/design.md
