---
name: Hackle
colors:
  primary: '#2962ff'
  on-primary: '#ffffff'
  primary-hover: '#1c44b2'
  hero-blue: '#0065ff'
  calculator-blue: '#005ff5'
  soft-blue: '#9ebaf4'
  table-tint: '#ebf1f7'
  table-highlight: '#b3d4ff'
  heading: '#000000'
  ink: '#151618'
  dark-hover: '#2c2d30'
  navy-ink: '#1e293b'
  graphite: '#2d2d2d'
  charcoal: '#424242'
  muted: '#5b6577'
  eyebrow: '#a3a3a3'
  grey: '#8e8e8e'
  canvas: '#fafafa'
  white: '#ffffff'
  hairline: '#e0e0e0'
  divider: '#ededed'
typography:
  display-hero:
    fontSize: 46px
    fontWeight: 700
    lineHeight: 1.52
    letterSpacing: '-1.84px'
    use: 'Home hero headline (AI와 데이터로 이끄는 성장 / 올인원 AI 그로스 플랫폼 핵클), 70px line, #000000; computes to the ui-sans-serif system stack, not a brand face'
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Home section heading (앞서가는 기업들은 이미 핵클의 고객사입니다.), 54px line, #000000, system stack'
  section-kr:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-1px'
    use: Home section headings set in Pretendard (데이터 기반으로 성장할 수 있는 방법을 확인해 보세요), 43.2px line
  subsection:
    fontSize: 26px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '-0.26px'
    use: Home integration heading (웹, 앱, 서버 상관없이 5분이면 사용 가능), Pretendard, 31.2px line
  service-title:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-1px'
    use: A/B test page and pricing section headings, Pretendard, 48px line, in rgba(0, 0, 0, 0.87)
  service-banner:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-1px'
    use: 'Blue banner heading on the A/B test page, Pretendard, 57.6px line, #2962ff'
  feature-title:
    fontSize: 35px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-1px'
    use: 'Feature headings on the A/B test page, 49px line, #0065ff, system stack'
  page-title:
    fontSize: 50px
    fontWeight: 700
    lineHeight: 1.5
    use: Title at the top of the pricing page, Pretendard, 75px line, in rgba(0, 0, 0, 0.87)
  eyebrow:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Grey kicker above home section headings, 36px line, #a3a3a3'
  lead:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-1px'
    use: Definition paragraph under A/B 테스트란?, Pretendard, 38.4px line
  faq-question:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: FAQ question rows on the pricing page (자주 묻는 질문), Pretendard, 30px line
  button-start:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.75
    use: A/B 테스트 시작하기 label, Pretendard, 35px line
  button-lg:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    use: Home hero CTA labels (데모 둘러보기, 상담 신청하기), 27px line, system stack
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.75
    use: Header 데모 둘러보기, pricing buttons and tool chips, Pretendard, 24.5px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Document default and navigation, 24px line, rgba(0, 0, 0, 0.87), system stack
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Footer legal links, 18px line, rgba(0, 0, 0, 0.3), system stack
rounded:
  button: 4px
  chip: 5px
  cta: 8px
  card: 8px
  tile: 10px
  link: 10px
  toggle: 36px
spacing:
  cta-y: 12
  cta-x: 32
  button-y: 6
  button-x: 16
  chip-x: 24
  card-pad: 24
  row-y: 24
  row-x: 27
  cell-y: 15
  cell-x: 16
components:
  header-demo-button:
    type: button
    backgroundColor: '#2962ff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 6px 16px
    height: 38px
    typography: 14px / 500 / 24.5px Pretendard
    hover: 'bg #1c44b2'
    pressed: 'bg #1c44b2'
    states: 'probe on /ko/pricing/: hover and pressed settle on #1c44b2 after a 0.25s cubic-bezier(0.4, 0, 0.2, 1) transition; keyboard focus (Tab #7) only adds the MUI ripple layers, no visible change, so no focus value is declared'
    use: 데모 둘러보기 in the fixed header of all three captured pages (capture 6 on each), 109 x 38; the site's persistent primary action
  contained-button:
    type: button
    backgroundColor: '#2962ff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 6px 16px
    height: 39px
    typography: 14px / 500 / 24.5px Pretendard
    shadow: rgba(0, 0, 0, 0.2) 0px 3px 1px -2px, rgba(0, 0, 0, 0.14) 0px 2px 2px 0px, rgba(0, 0, 0, 0.12) 0px 1px 5px 0px
    hover: 'bg #1c44b2; shadow rgba(0, 0, 0, 0.2) 0px 2px 4px -1px, rgba(0, 0, 0, 0.14) 0px 4px 5px 0px, rgba(0, 0, 0, 0.12) 0px 1px 10px 0px'
    pressed: 'bg #1c44b2; shadow rgba(0, 0, 0, 0.2) 0px 5px 5px -3px, rgba(0, 0, 0, 0.14) 0px 8px 10px 1px, rgba(0, 0, 0, 0.12) 0px 3px 14px 2px'
    states: 'probe on /ko/pricing/ (카드 등록하고 바로 사용하기, 문의하기): hover and pressed settle on #1c44b2 with a deeper shadow; keyboard focus (Tab #8, #9) raises the shadow to rgba(0, 0, 0, 0.2) 0px 3px 5px -1px, rgba(0, 0, 0, 0.14) 0px 6px 10px 0px, rgba(0, 0, 0, 0.12) 0px 1px 18px 0px with no colour change'
    use: Plan buttons on the pricing page at surface-3::[data-omd-capture="7"] (234 x 39) and capture 8 (94 x 39)
  start-button:
    type: button
    backgroundColor: '#2962ff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 20px
    height: 59px
    typography: 20px / 500 / 35px Pretendard
    hover: 'bg #1c44b2'
    pressed: 'bg #1c44b2'
    states: 'probe on /ko/service/ab-test/: hover and pressed settle on #1c44b2 with the same shadow rise as the pricing buttons; keyboard focus (Tab #9) changes only the shadow'
    use: A/B 테스트 시작하기 at the top of the A/B test page, surface-2::[data-omd-capture="8"], 207 x 59
  hero-cta:
    type: button
    backgroundColor: '#0065ff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 32px
    height: 53px
    typography: 18px / 700 / 27px system stack
    hover: 'bg #0065ff at 90% alpha'
    pressed: 'bg #0065ff at 90% alpha'
    states: 'probe on home: hover and pressed settle on oklab(0.561563 -0.038043 -0.238921 / 0.9), the hero blue at 90% alpha, after a 0.15s transition; keyboard focus (Tab #8) draws only the browser''s default ring, so no focus value is declared'
    use: 데모 둘러보기 under the home hero, home::[data-omd-capture="7"], 162 x 53
  hero-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0065ff'
    border: '1px solid #0065ff'
    rounded: 8px
    padding: 12px 32px
    height: 53px
    typography: 18px / 700 / 27px system stack
    states: 'probe on home: hover and pressed show no change across the button and three ancestor levels; keyboard focus draws only the browser''s default ring'
    use: 상담 신청하기 beside the hero CTA, home::[data-omd-capture="8"], 164 x 53
  dark-chip:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 5px
    padding: 0px 24px
    height: 44px
    typography: 14px / 500 / 24.5px Pretendard
    hover: 'bg #2c2d30'
    pressed: 'bg #2c2d30'
    states: 'probe on home: hover and pressed settle on #2c2d30; keyboard focus (Tab #10) only adds ripple layers'
    use: 간편발송 바로가기 in the home Simple Send band, home::[data-omd-capture="9"], 189 x 44
  white-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#151618'
    rounded: 5px
    padding: 10px 20px
    height: 44px
    typography: 14px / 500 / 24.5px Pretendard
    hover: 'bg rgba(255, 255, 255, 0.9), fg #000000'
    pressed: 'bg rgba(255, 255, 255, 0.9), fg #000000'
    states: 'probe on home (가이드북 다운받기): hover and pressed turn the fill 90% white and the label and icon #000000; the focus read changed only the chip''s width, so no focus value is declared'
    use: Guide and template chips on the home resource tiles, home::[data-omd-capture="10"] to 13, 226 x 44
  outline-chip:
    type: button
    backgroundColor: transparent
    textColor: '#151618'
    border: '1px solid #151618'
    rounded: 5px
    padding: 5px 15px
    height: 40px
    typography: 16px / 700 / 28px Pretendard
    hover: 'bg rgba(21, 22, 24, 0.04), fg and border #000000'
    pressed: 'bg rgba(21, 22, 24, 0.04), fg and border #000000'
    states: 'probe on home: hover and pressed add a 4% ink wash and turn label and border #000000; keyboard focus (Tab #15) only adds ripple layers'
    use: 연동 가이드 보기 under the integration heading, home::[data-omd-capture="14"], 138 x 40
  dashboard-button:
    type: button
    backgroundColor: '#151618'
    textColor: '#ffffff'
    rounded: 4px
    padding: 6px 16px
    height: 33px
    typography: 14px / 500 / 24.5px Pretendard
    hover: 'bg #2c2d30'
    pressed: 'bg #2c2d30'
    states: 'probe on home: hover and pressed settle on #2c2d30; keyboard focus (Tab #17) no change'
    use: 대시보드 둘러보기 in the closing home band, home::[data-omd-capture="16"], 157 x 33
  calculator-link:
    type: button
    backgroundColor: '#005ff5'
    textColor: '#ffffff'
    rounded: 10px
    padding: 12px 24px
    height: 47px
    typography: 15px / 700 / 22.5px system stack
    hover: opacity 0.9
    pressed: opacity 0.9
    states: 'probe on /ko/service/ab-test/: hover and pressed settle at opacity 0.9 after a 0.15s opacity transition; keyboard focus (Tab #10) draws only the browser''s default ring'
    use: 무료 A/B 테스트 계산기 사용하기 → on the A/B test page, surface-2::[data-omd-capture="9"], 264 x 47
  mode-toggle:
    type: tab
    backgroundColor: transparent
    rounded: 36px
    padding: 0px 8px
    height: 48px
    selected: 'bg #2962ff'
    states: selected and unselected read from rest values of the pair (captures 10 and 11); the labels sit in children the collector did not record, so no label colour is declared; no pointer frame
    use: Two-way example switch under 어떤 A/B 테스트를 해볼 수 있을까요? on the A/B test page, 177 x 48 each
  nav-link:
    type: tab
    textColor: '#000000'
    height: 72px
    typography: 16px / 400 / 24px system stack
    states: rest only on all three pages; no pointer frame or probe
    use: Header navigation items (captures 1 to 5 on each page), 72px tall row
  pricing-table-header:
    type: card
    backgroundColor: '#0065ff'
    textColor: '#ffffff'
    border: '1px solid #e0e0e0'
    padding: 25px 16px
    height: 75px
    typography: 18px / 600 / 24px Pretendard (20px on the first column)
    use: Header row of the plan comparison table on the pricing page, surface-3::tr and surface-3::th
  pricing-table-row:
    type: card
    backgroundColor: '#ebf1f7'
    border: '1px solid #e0e0e0'
    padding: 15px 16px
    height: 60px
    typography: 20px / 700 / 28.6px Pretendard for group rows; 18px / 400 / 25.74px for cells
    use: 'Group rows of the comparison table in #ebf1f7; highlighted rows in #b3d4ff; plain rows transparent with a #e0e0e0 bottom border'
  faq-row:
    type: card
    border: '1px solid #ededed (top)'
    padding: 24px 27px
    height: 79px
    states: 11 rows captured at rest; none was opened
    use: Rows under 자주 묻는 질문 on the pricing page, surface-3::[data-omd-capture="9"] to 19, 1248 wide
  solution-card:
    type: card
    backgroundColor: rgba(0, 0, 0, 0.87)
    rounded: 8px
    padding: 24px
    height: 375px
    use: Four dark team cards under 팀 별로 필요한 모든 것을 하나의 대시보드에서 on home, 285 x 375
  feature-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    height: 360px
    use: 'Three white cards under 데이터 기반으로 성장할 수 있는 방법을 확인해 보세요 on home, 353 x 360, each opening on a #9ebaf4 panel 206px tall'
fonts:
  roles:
    body: Pretendard
---

# Hackle

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Hackle; reproduced for educational reference. Full prose: https://oh-my-design.kr/hackle/design.md
