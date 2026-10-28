---
name: ZEPETO
colors:
  primary: '#5c46ff'
  on-primary: '#ffffff'
  ink: '#292930'
  web-ink: '#000008'
  body: '#5c5c61'
  muted: '#47474d'
  black: '#000000'
  canvas: '#ffffff'
  surface: '#f5f5f6'
  surface-alt: '#f8f8fa'
  hairline: '#e0e0e1'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 800
    lineHeight: 1.09
    use: Hero headline on both Studio pages (h2.content-title), white, -apple-system stack
  card-title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    use: Feature card titles and service names on the Studio world page
  service-name:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Service names on Studio home (아이템, 월드, 라이브)
  guide-title:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.36
    use: Guide card titles on the Studio world page
  hero-button:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 3.09
    use: Hero pill label (시작하기, 월드 만들기), set on a 68px line box
  link-lg:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.4
    use: 더 알아보기 links on the Studio guide cards
  nav:
    fontSize: 17px
    fontWeight: 500
    lineHeight: 1.15
    use: Studio top navigation; the current item steps to 700
  button:
    fontSize: 17px
    fontWeight: 500
    lineHeight: 2.82
    use: Violet Studio action label (더 알아보기), set on a 48px line box
  entry-button:
    fontSize: 17px
    fontWeight: 500
    lineHeight: 1.29
    use: 입장하기 on the web lobby's hero world banners, ui-sans-serif stack
  body:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.41
    use: Descriptions on the Studio world page
  body-sm:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.33
    use: Service descriptions on Studio home (letter-spacing -0.2px)
  world-name:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.47
    use: World names under the web lobby's world tiles, ui-sans-serif stack
  web-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.15
    use: Web lobby body text, ui-sans-serif stack
  utility-button:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.33
    use: 내 콘텐츠 in the Studio header; the web lobby's 로그인 uses 15px / 500 / 20px
  menu:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Options in the Studio language dropdown
rounded:
  none: 0px
  button: 8px
  thumbnail: 12px
  card: 16px
  pill: 24px
  hero-pill: 34px
spacing:
  button-y: 10
  button-x: 16
  entry-y: 14
  entry-x: 34
  pill-x: 34
  card-pad: 32
  guide-pad: 36
  option-y: 8
  option-x: 24
components:
  web-login-button:
    type: button
    backgroundColor: '#292930'
    textColor: '#ffffff'
    rounded: 8px
    padding: 10px 16px
    height: 40px
    typography: 15px / 500 / 20px ui-sans-serif stack
    states: rest only; no pointer frame was recorded
    use: 로그인 in the web lobby header, 80 x 40 (read, never followed)
  zem-button:
    type: button
    backgroundColor: '#f5f5f6'
    textColor: '#000000'
    rounded: 8px
    padding: 10px 16px
    height: 40px
    typography: 16px / 400 / 18.4px ui-sans-serif stack
    states: rest only; no pointer frame
    use: ZEM 구매 in the web lobby header, 114 x 40 (not opened)
  world-entry-button:
    type: button
    backgroundColor: '#f5f5f6'
    textColor: '#47474d'
    rounded: 8px
    padding: 14px 34px
    height: 56px
    typography: 17px / 500 / 22px ui-sans-serif stack
    states: rest on three instances; no pointer frame
    use: 입장하기 on the three hero world banners of the web lobby, 182 x 56
  carousel-control:
    type: button
    backgroundColor: rgba(199, 199, 201, 0.5)
    rounded: 50%
    size: 36px x 36px
    states: rest only
    use: Left and right arrows of the web lobby's hero carousel
  world-card:
    type: card
    backgroundColor: rgba(248, 248, 250, 0.5)
    textColor: '#000008'
    rounded: 12px
    size: 152px x 152px
    typography: 15px / 500 / 22px ui-sans-serif stack
    use: 'World tiles in the web lobby grid (157 tiles): a 12px-radius thumbnail on a translucent #f8f8fa ground over the world name'
  studio-primary-button:
    type: button
    backgroundColor: '#5c46ff'
    textColor: '#ffffff'
    rounded: 24px
    padding: 0px
    height: 48px
    typography: 17px / 500 / 48px -apple-system stack
    states: rest on three instances; no pointer frame
    use: 더 알아보기 under each Studio service card (아이템, 월드, 라이브), 200 x 48
  hero-pill-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5c46ff'
    rounded: 34px
    padding: 0px 34px
    height: 68px
    typography: 22px / 700 / 68px -apple-system stack
    shadow: rgba(0, 0, 0, 0.2) 0px 0px 20px 0px
    states: rest on both Studio pages; no pointer frame
    use: 시작하기 on the Studio home hero (144 x 68) and 월드 만들기 on the world page hero (168 x 68)
  my-content-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#292930'
    rounded: 8px
    padding: 10px 16px
    height: 40px
    typography: 15px / 600 / 20px -apple-system stack
    states: rest on both Studio pages; no pointer frame
    use: 내 콘텐츠 in the Studio header, 88 x 40 (not followed)
  studio-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: rgba(255, 255, 255, 0.6)
    padding: 15px 16px
    height: 50px
    typography: 17px / 500 / 19.55px -apple-system stack
    hover: 'fg #ffffff'
    pressed: 'fg #ffffff'
    selected: 'fg #ffffff at weight 700 on the current section''s item (world page)'
    states: 'hover and pressed frames read opaque #ffffff on all five items on Studio home and all four inactive items on the world page'
    use: Studio top navigation over the dark hero (five items on Studio home)
  language-dropdown:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#292930'
    border: '1px solid #e0e0e1 (trigger)'
    rounded: 8px
    padding: 8px 0px (list); 8px 24px (option)
    height: 36px (trigger)
    typography: 14px / 500 / 20px -apple-system stack
    shadow: rgba(0, 0, 0, 0.08) 0px 2px 6px 0px
    selected: 'bg #f8f8fa on the aria-selected option'
    states: opened by the collector's expansion pass on both Studio pages (expanded, menu-open)
    use: '한국어 language switcher in the Studio footer: a 74 x 36 trigger opening a 180-wide list of seven languages'
  service-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#292930'
    rounded: 16px
    padding: 42px 32px 32px
    size: 320px x 416px
    use: 아이템, 월드, 라이브 cards on Studio home, each ending in the violet 더 알아보기
  world-feature-card:
    type: card
    textColor: '#292930'
    rounded: 16px
    size: 320px x 438px
    shadow: rgba(0, 0, 0, 0.05) 0px 2px 12px 0px
    typography: 28px / 700 / 36px title; 17px / 400 / 24px text
    use: '모험, 소통, 도전 cards on the Studio world page: image above, title and #5c5c61 text below'
  guide-card:
    type: card
    backgroundColor: '#f8f8fa'
    textColor: '#292930'
    rounded: 16px
    padding: 36px 36px 64px
    size: 368px x 244px
    use: 개발 가이드, 출시 가이드, 수익 창출 가이드 cards on the Studio world page
  guide-link:
    type: button
    backgroundColor: transparent
    textColor: '#5c46ff'
    padding: 0px 16px 0px 0px
    height: 28px
    typography: 20px / 500 / 28px -apple-system stack
    states: rest on three instances; no pointer frame
    use: 더 알아보기 link at the foot of each guide card
fonts:
  roles:
    sans: '-apple-system'
    web: ui-sans-serif
---

# ZEPETO

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ZEPETO; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/zepeto/DESIGN.md
