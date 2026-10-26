---
name: Ringle
colors:
  primary: '#3e00d9'
  on-primary: '#ffffff'
  deep-violet: '#1d0788'
  navy: '#120968'
  app-violet: '#3c2bac'
  promo-violet: '#5442fb'
  sky: '#1170ff'
  promo-red: '#e80023'
  promo-yellow: '#ffe999'
  lilac: '#aa9dff'
  ink: '#000000'
  ink-soft: '#0d0d0d'
  body: '#242730'
  slate: '#4f545c'
  muted: '#6e737c'
  faint: '#9ea3ab'
  app-slate: '#3e426a'
  app-muted: '#80839e'
  hairline: '#e4e7f4'
  nav-hover: '#fbfbff'
  white: '#ffffff'
typography:
  display-hero:
    fontSize: 50px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-2.25px'
    use: 'Hero headline on /ko/1on1 and /ko/student/landing/home (영어는 실전처럼), Pretendard JP Bold, 62.5px line, in #000000; dark-band headlines use the same style in #ffffff with a lilac second line'
  section-xl:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-1.92px'
    use: Large stacked section headlines on /ko/1on1, Pretendard JP Bold, 60px line
  section:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-1.6px'
    use: 'Section headlines on both Framer pages, Pretendard JP Bold, 48px line, in #000000 or #0d0d0d'
  subsection:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.96px'
    use: 'Feature headlines on /ko/1on1, Pretendard JP Bold, 40px line; the accented half of a headline turns #3e00d9'
  card-title:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: '-0.65px'
    use: Card and list headings on /ko/student/landing/home (60 instances), Pretendard JP Bold, 33.8px line
  button-lg:
    fontSize: 18px
    fontWeight: 700
    use: '링글 시작하기 label, a Framer text element inside the button, in #ffffff'
  lead:
    fontSize: 17px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: '-0.425px'
    use: 'Review and story copy on /ko/1on1, Pretendard JP Medium, 23.8px line, in #242730'
  body-strong:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: '-0.4px'
    use: 'Descriptions under the card headings on /ko/student/landing/home, Pretendard JP SemiBold, 25.6px line, in #4f545c'
  body:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: '-0.35px'
    use: 'Running copy on the Framer pages, Pretendard JP Medium, 22.4px line, in #6e737c'
  caption:
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: '-0.2px'
    use: 'Review metadata on /ko/1on1, Pretendard JP Medium, 16px line, in #6e737c'
  app-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Section headings on /ko/company, Pretendard Variable, 36px line, in #000000'
  app-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Header navigation rows on /ko/company, Pretendard Variable, 24px line
  app-label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.57
    use: 'Footer lists and header button labels on /ko/company, Pretendard Variable, 22px line, footer lists in #80839e'
rounded:
  nav: 4px
  chip: 4px
  header-button: 5px
  tile: 7px
  cta: 8px
  pill: 16px
  banner: 24px
  arrow: 40px
  circle: 100px
spacing:
  action-y: 16
  action-x: 24
  pill-y: 14
  pill-x: 16
  banner-y: 60
  banner-x: 80
  chip-y: 10
  chip-x: 16
  header-y: 8
  header-x: 16
  nav-y: 4
  nav-x: 6
  tile: 12
components:
  start-button:
    type: button
    backgroundColor: '#3e00d9'
    textColor: '#ffffff'
    rounded: 8px
    height: 61px
    typography: 18px / 700 Pretendard JP Bold (label)
    states: 'focus (Tab #11) draws only the browser''s default ring; hover and pressed are unmeasured because a Channel Talk modal covered the button even with --hide-overlays; transition all 0s'
    use: '링글 시작하기, the primary action: 200 x 61 in the hero of /ko/1on1 and /ko/student/landing/home, repeated at 320 x 61 three more times down /ko/1on1'
  band-button:
    type: button
    backgroundColor: '#1d0788'
    rounded: 8px
    padding: 16px 24px
    height: 57px
    states: rest only; the bundle's pressed frame changes nothing but the browser's default link colour, which is not a brand state
    use: 320 x 57 actions inside the product bands of /ko/1on1 (captures 19 and 20); the label element was not recorded
  product-button:
    type: button
    backgroundColor: '#120968'
    rounded: 8px
    height: 60px
    states: rest only; the collector's pseudo-state pass on /ko/student/landing/home stalled and was logged unmeasured, and the probe did not reach this control
    use: '200 x 60 더 알아보기-sized actions in the product list of /ko/student/landing/home; siblings fill #3e00d9, #1d0788 and #1170ff; labels not recorded'
  promo-pill:
    type: button
    backgroundColor: '#5442fb'
    textColor: '#ffffff'
    rounded: 16px
    padding: 14px 16px
    height: 80px
    typography: 20px / 700 Pretendard JP Bold (label)
    states: 'focus (Tab #10) draws only the browser''s default ring; hover and pressed unmeasured'
    use: 9회말 역전 이벤트 특가 확인하기, a 660 x 80 promotion link under the hero of both Framer pages; time-boxed campaign
  promo-banner:
    type: card
    backgroundColor: '#e80023'
    rounded: 24px
    padding: 60px 0px 60px 80px
    size: 1180px x 170px
    use: 'Promotion banner card on both Framer pages with a #ffe999 32px heading; time-boxed campaign'
  top-bar:
    type: card
    backgroundColor: '#0d0d0d'
    size: 1440px x 44px
    use: Full-width countdown bar at the top of both Framer pages (내일 마감! 9월 마지막 역전 찬스, 최대 59% 할인!); time-boxed campaign
  site-header:
    type: card
    backgroundColor: '#ffffff'
    shadow: 0px 4px 30px rgba(20, 15, 51, 0.05)
    use: Header container of /ko/1on1 behind the navigation, the only shadow observed
  nav-link:
    type: tab
    textColor: '#0d0d0d'
    typography: 14px / 500 Pretendard JP Medium
    height: 30px
    states: 'focus (Tab #3) draws only the browser''s default ring; hover and pressed unmeasured (the Channel Talk modal backdrop was on top)'
    use: Header navigation of the Framer pages (튜터, 교재, 학습 체계, AI, 후기, 가격, 기업 교육)
  app-trial-button:
    type: button
    backgroundColor: '#3c2bac'
    textColor: '#ffffff'
    rounded: 5px
    padding: 8px 16px
    height: 40px
    typography: 14px / 500 Pretendard Variable
    states: 'hover, pressed and focus (Tab #11) show no change across the button, its label and three ancestor levels; transition all 0s'
    use: 무료 체험하기 in the header of /ko/company, the Next.js web template, 108 x 40 in the probe
  app-login-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3c2bac'
    border: '1px solid #3c2bac'
    rounded: 5px
    padding: 8px 16px
    height: 40px
    typography: 14px / 500 Pretendard Variable
    states: 'hover, pressed and focus (Tab #12) show no change'
    use: 로그인 beside 무료 체험하기 in the /ko/company header
  app-nav-item:
    type: tab
    textColor: '#3e426a'
    rounded: 4px
    padding: 4px 6px
    typography: 14px / 500 Pretendard Variable
    hover: 'row bg #fbfbff'
    pressed: 'row bg #fbfbff'
    states: 'hover and pressed tint the parent row #fbfbff; focus (Tab #9) draws only the browser''s default ring'
    use: Header navigation of /ko/company (1:1 화상영어, 튜터, 교재, 기업 교육)
  tile-button:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #e4e7f4'
    rounded: 7px
    padding: 12px
    height: 48px
    typography: 14px / 500 Pretendard Variable
    states: rest on four captured instances; no state frame and no probe read
    use: 112 x 48 white tiles in a row of four near the foot of /ko/company
  filter-chip:
    type: button
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 10px 16px
    height: 42px
    states: rest on four captured instances; the pseudo-state pass on this page stalled, so hover and pressed are unmeasured
    use: White 112 x 42 chips in a row of four on /ko/student/landing/home (captures 42-45); labels not recorded
  carousel-arrow:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.2)
    rounded: 40px
    size: 40px x 40px
    states: rest on two captured instances; hover and pressed unmeasured
    use: Translucent round arrows over the hero carousel of /ko/student/landing/home
  round-button:
    type: button
    backgroundColor: '#ffffff'
    rounded: 100px
    size: 40px x 40px
    states: rest only; hover and pressed unmeasured
    use: White round control after the chip row on /ko/student/landing/home
  story-card:
    type: card
    rounded: 8px
    size: 333px x 331px
    use: Story cards on /ko/1on1; their fill is imagery
fonts:
  roles:
    display: Pretendard JP Bold
    body: Pretendard JP Medium
    app: Pretendard Variable
---

# Ringle

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ringle; reproduced for educational reference. Full prose: https://oh-my-design.kr/ringle/design.md
