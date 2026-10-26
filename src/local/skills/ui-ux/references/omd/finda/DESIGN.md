---
name: Finda
colors:
  primary: '#4e2eed'
  on-primary: '#ffffff'
  accent: '#5d4cf2'
  accent-hover: '#7164f8'
  ink: '#010a26'
  ink-pure: '#000000'
  charcoal: '#15161b'
  body: '#444857'
  slate: '#3a415a'
  muted: '#65798e'
  muted-alt: '#737a94'
  white: '#ffffff'
  surface: '#f6f6f9'
  hairline: '#e9e9e9'
typography:
  display-hero:
    fontSize: 50px
    fontWeight: 800
    lineHeight: 1.32
    letterSpacing: '-0.75px'
    use: 'Home hero headline (금융 선택의 기준을 바꾸다), SUIT, 66px line, in #000000'
  display-culture:
    fontSize: 52px
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: '-0.78px'
    use: 'Culture page headline (누구도 가지 않은 금융 혁신의 길을 만듭니다), SUIT, 73px line, in #15161b'
  section-lg:
    fontSize: 46px
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: '-0.69px'
    use: Large section headings on home and culture, SUIT, 60px line
  section:
    fontSize: 34px
    fontWeight: 800
    lineHeight: 1.41
    letterSpacing: '-0.51px'
    use: Home section heading (대출 비교부터 신청까지), SUIT, 48px line
  subsection:
    fontSize: 28px
    fontWeight: 800
    lineHeight: 1.43
    letterSpacing: '-0.42px'
    use: Feature headings on home (악성 앱 차단, 신용관리) and culture, SUIT, 40px line
  card-title:
    fontSize: 24px
    fontWeight: 800
    lineHeight: 1.42
    letterSpacing: '-0.47px'
    use: Work-principle tile headings on the culture page, SUIT, 34px line, -0.4656px tracking
  lead:
    fontSize: 25px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.49px'
    use: 'Home hero subline, SUIT, 35px line, -0.485px tracking, in #444857'
  company-title:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: '-0.14px'
    use: Section headings on /about-us (핀다 연혁, 핀다 프로덕트, 핀다 언론보도), Pretendard, 37.8px line
  button-lg:
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: '-0.17px'
    use: Large pill action labels (채용공고 확인하기, 더 이상 보지 않기, 닫기), Pretendard, 22.95px line
  nav:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.56
    use: Header navigation labels, SUIT on home and culture, Pretendard on /about-us, 23.4px line
  tab:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.64
    use: Benefit filter tabs on the culture page, SUIT, 23px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: '-0.16px'
    use: 'Review text on home, SUIT, 28px line, in #444857'
  button-sm:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Header 앱 다운받기 label, SUIT (Pretendard on /about-us), 18px line
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.65
    use: 'Footer company disclosure, SUIT, 21.45px line, in #65798e'
  fine:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.56
    use: 'Footer legal notes, SUIT, 17.16px line, in #65798e'
rounded:
  tag: 2px
  card: 6px
  tile: 10px
  tab: 43px
  link: 52px
  chip: 60px
  cta: 100px
  pill: 9999px
spacing:
  chip-x: 29
  tab-y: 14
  tab-x: 28
  card-y: 40
  card-x: 32
components:
  header-download-button:
    type: button
    backgroundColor: '#4e2eed'
    textColor: '#ffffff'
    rounded: 100px
    height: 33px
    typography: 12px / 400 / 18px SUIT (Pretendard on /about-us)
    states: 'probe on /about-us and home: hover, pressed and focus (Tab #2) show no change across the button and three ancestor levels, and it computes transition all 0s'
    use: 앱 다운받기 in the fixed header of all three pages at home::[data-omd-capture="1"], a fixed 105 x 33 pill
  pill-cta:
    type: button
    backgroundColor: '#5d4cf2'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 4px 0px
    height: 54px
    typography: 17px / 600 / 22.95px Pretendard, letter-spacing -0.17px
    hover: 'bg #7164f8'
    pressed: 'bg #7164f8'
    states: 'hover and pressed settle on #7164f8 (transition all 0s; bundle frames and the probe agree); focus (Tab #6) shows no change'
    use: 'Large violet pill: 채용공고 확인하기 on /about-us at surface-2::[data-omd-capture="5"] (1180 x 54) and 더 이상 보지 않기 in the home notice dialog (365 x 54)'
    focus: no visible change (measured 2026-10-16) on :focus-visible
  dialog-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5d4cf2'
    border: '1px solid #5d4cf2'
    rounded: 9999px
    padding: 4px 12px
    height: 54px
    typography: 17px / 600 / 22.95px Pretendard, letter-spacing -0.17px
    hover: 'bg #f0eeff'
    pressed: 'bg #f0eeff'
    states: 'hover and pressed settle on #f0eeff (transition all 0s); focus (Tab #33) shows no change'
    use: 닫기 beside 더 이상 보지 않기 in the home notice dialog at home::[data-omd-capture="32"], 120 x 54
  calculator-chip:
    type: button
    backgroundColor: '#15161b'
    rounded: 60px
    padding: 14.48px 29px
    height: 48px
    states: rest on six captured chips (home captures 2-7); the probe could not locate them on two loads while the home notice dialog was open, so no hover, pressed or focus value is declared
    use: Calculator shortcuts under 모든 계산을 쉽고 빠르게 on home (대출이자, 연봉 실수령, 전월세 비교, DSR, 내 집 대출한도, 연말정산), 153 x 48; the label sits in a child element the collector did not record, so no label colour or font is declared
  more-chip:
    type: button
    backgroundColor: '#15161b'
    rounded: 60px
    padding: 0px 20px
    height: 48px
    states: rest on two captured instances; no state frame
    use: 더 보러가기 under the review and story sections on home at home::[data-omd-capture="8"], 153 x 48
  culture-filter-tab:
    type: tab
    backgroundColor: '#f6f6f9'
    textColor: '#15161b'
    rounded: 43px
    padding: 14px 28px
    height: 51px
    typography: 14px / 700 / 23px SUIT
    selected: 'bg #15161b, fg #ffffff'
    hover: 'bg #e0e3eb'
    pressed: 'bg #e0e3eb'
    states: 'unselected tabs settle on #e0e3eb on hover and pressed after a 0.15s colour transition; the selected tab shows no change; focus (Tabs #9 and #10) shows no change on either'
    use: Benefit filter tabs on the culture page (최고의 환경, 스페셜 보상, 성장 지원, 재충전, 생활 속 지원) at surface-3::[data-omd-capture="10"]; recruiting page
  nav-item:
    type: tab
    textColor: '#3a415a'
    height: 56px
    typography: 15px / 400 / 23.4px SUIT
    selected: 'fg #5d4cf2 on the current section''s item (핀다 on home and /about-us, 채용 on /culture)'
    states: selected variant read from rest values on three pages; no pointer frame
    use: Header navigation items (핀다, 서비스, 문의, 핀다포스트, 채용) in 165 x 56 list cells
  biz-info-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#65798e'
    border: '1px solid #e9e9e9'
    rounded: 2px
    padding: 2px 8px
    height: 22px
    typography: 12px / 400 / 16px Pretendard
    states: 'probe on /about-us: hover, pressed and focus (Tab #27) show no change'
    use: 사업자정보확인 > disclosure toggle in the footer at surface-2::[data-omd-capture="26"], 101 x 22
  join-link:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#15161b'
    rounded: 52px
    padding: 14px 30px
    height: 54px
    typography: 17px / 800 SUIT
    hover: opacity 0.9
    pressed: opacity 0.9
    states: 'hover and pressed settle at opacity 0.9 after a 0.15s opacity transition; focus (Tab #18) draws only the browser''s default ring, so no brand focus style is declared'
    use: 핀다 크루 합류하기 over the closing image of the culture page, 186.7 x 54, linking to the recruiting site; recruiting page, read by the fixed probe
  card-carousel-arrow:
    type: button
    backgroundColor: transparent
    rounded: 9999px
    size: 40px x 40px
    disabled: capture 7 is disabled at rest and computes the same values as the enabled capture 8
    states: rest and disabled only; no pointer frame
    use: Previous and next arrows of the benefit card carousel on the culture page at surface-3::[data-omd-capture="8"]; recruiting page
  tile-arrow:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.2)
    rounded: 9999px
    size: 40px x 40px
    states: rest on five captured instances; no state frame
    use: Round translucent arrows on the work-principle tiles of the culture page at surface-3::[data-omd-capture="2"]; recruiting page
  value-card:
    type: card
    backgroundColor: '#f6f6f9'
    rounded: 6px
    padding: 40px 32px
    size: 285px x 340px
    use: Grey benefit cards under the culture filter tabs (21 instances); recruiting page
  benefit-card:
    type: card
    backgroundColor: '#f6f6f9'
    rounded: 10px
    padding: 40px 18px
    size: 256px x 400px
    use: Grey cards in the culture page carousel (10 instances); recruiting page
  culture-tile:
    type: card
    rounded: 10px
    size: 590px x 590px
    use: Square work-principle tiles on the culture page, each on its own illustration fill; the fills are artwork, not tokens; recruiting page
  notice-dialog:
    type: dialog
    backgroundColor: rgba(0, 0, 0, 0.4) (backdrop)
    size: 1440px x 900px (fixed, full viewport)
    use: Notice dialog open over home at capture, with 더 이상 보지 않기 and 닫기 at its foot
fonts:
  roles:
    display: SUIT
    body: Pretendard
---

# Finda

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Finda; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/finda/DESIGN.md
