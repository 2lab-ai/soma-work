---
name: Korea Credit Data
colors:
  primary: '#2d91ff'
  navy: '#192d82'
  ink: '#1e2137'
  ink-deep: '#0c1120'
  ink-black: '#000000'
  body: '#44546f'
  gray: '#666666'
  muted: '#728094'
  grey: '#9f9f9f'
  faint: '#a4aeba'
  sky: '#57a8ff'
  hairline: '#d9d9d9'
  surface: '#f4f7f9'
  on-blue: '#f3faff'
  white: '#ffffff'
typography:
  product-display:
    fontSize: 72px
    fontWeight: 700
    lineHeight: 1.19
    use: 'CashNote product site (cashnote.kr): hero headline, 86px line, in #f3faff'
  display:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.27
    use: Corporate page heroes on kcd.co.kr (home, /about/, /service/), 66px line, white over imagery
  product-section:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.21
    use: 'CashNote product site (cashnote.kr): section headlines, 68px line, in #192d82'
  section:
    fontSize: 46px
    fontWeight: 700
    lineHeight: 1.35
    use: 'Corporate section headings, 62px line, in #1e2137 (white on dark bands)'
  product-feature:
    fontSize: 44px
    fontWeight: 700
    lineHeight: 1.27
    use: 'CashNote product site (cashnote.kr): feature headings, 56px line, in #192d82'
  service-lead:
    fontSize: 44px
    fontWeight: 300
    lineHeight: 1.23
    use: 'Light-weight service introductions on /service/, 54px line, in #1e2137'
  card-title:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.45
    use: 'Card titles on the corporate pages, 32px line, in #1e2137, or #57a8ff on dark bands'
  eyebrow:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.56
    use: 'Section eyebrows above corporate headings, 28px line, in #192d82 (#57a8ff on dark bands)'
  menu:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1
    use: Full-screen menu items (회사소개, 서비스, 팀 문화, 인재영입, 새 소식), 18px line
  lead:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.67
    use: 'Lead paragraphs under corporate headings, 30px line, in #1e2137'
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: 'Header navigation over the hero, 16px line, white; the current page''s item turns #2d91ff'
  button:
    fontSize: 16px
    fontWeight: 700
    use: Corporate ghost button labels (서비스 보기, 자세히 보기, 더보기)
  product-button:
    fontSize: 19px
    fontWeight: 700
    lineHeight: 1.37
    use: 'CashNote product site (cashnote.kr): hero 앱 다운로드 label, 26px line'
  product-button-sm:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.63
    use: 'CashNote product site (cashnote.kr): header 캐시노트 시작하기 label, 26px line'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: 'Card descriptions and body copy, 26px line, in #666666'
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.71
    use: 'Footer company details, 24px line, in #44546f'
  fine:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.54
    use: 'Footer legal line, 20px line, in #728094'
rounded:
  ghost: 6px
  soft: 12px
  soft-lg: 16px
  pill: 100px
spacing:
  ghost-y: 15
  ghost-x: 32
  menu-bottom: 25
  tab-x: 23
  chip-y: 3
  chip-x: 25
  soft-x: 12
  soft-lg-x: 16
  download-y: 12
  download-x: 28
components:
  ghost-button:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #1e2137'
    rounded: 6px
    padding: 15px 32px
    height: 51px
    typography: 16px / 700
    hover: 'bg #192d82, fg #ffffff, border #192d82'
    pressed: 'bg #192d82, fg #ffffff, border #192d82'
    states: 'probe on home: hover and pressed fill the button #192d82 with a #ffffff label after a 0.2s transition; focus draws no authored style (the Tab landing only finished an ancestor''s scroll-reveal)'
    use: 서비스 보기 and 자세히 보기 on home (260 x 51); 캐시노트 바로가기, Google Play and Apple Store on /service/ (260 x 59). The button element computes Arial 13.33px; the visible label is a child span whose family was not recorded
  ghost-link:
    type: button
    backgroundColor: transparent
    textColor: '#1e2137'
    border: '1px solid #1e2137'
    rounded: 6px
    padding: 15px 32px
    height: 48px
    typography: 16px / 700 / 16px Pretendard
    hover: 'bg #192d82, fg #ffffff, border #192d82'
    pressed: 'bg #192d82, fg #ffffff, border #192d82'
    states: 'probe: hover and pressed settle on #192d82 with a #ffffff label (transition all 0.2s); focus shows only the browser''s default ring'
    use: 더보기 under the news list on home, 260 x 48
  ghost-inverse:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 6px
    padding: 15px 32px
    height: 51px
    typography: 16px / 700
    states: rest only; not probed
    use: 데이터 랩 바로가기 on the dark band of /service/ and 인재영입 중 on home
  menu-item:
    type: tab
    textColor: '#1e2137'
    border: '1px solid #d9d9d9 (bottom only)'
    padding: 0px 0px 25px
    height: 44px
    typography: 18px / 700 / 18px Pretendard
    selected: 'fg #2d91ff on the current section (회사소개 on /about/, 서비스 on /service/)'
    states: selected variant from rest values; no pointer frame
    use: Full-screen menu list, 1380 x 44 rows
  header-nav-item:
    type: tab
    textColor: '#ffffff'
    height: 16px
    typography: 16px / 400 / 16px Pretendard
    selected: 'fg #2d91ff on the current page'
    states: selected variant from rest values on /about/ and /service/; no pointer frame
    use: 'Header navigation over the hero image (회사소개, 서비스, 팀 문화, 인재영입, 새 소식); two secondary header links, one of them 데이터 랩, sit in #a4aeba'
  leadership-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#9f9f9f'
    border: '1px solid #d9d9d9'
    rounded: 100px
    padding: 0px 23px
    height: 44px
    typography: 18px / 500 / 26px (the button computes Arial; see §3)
    selected: 'fg #ffffff with a 1px #192d82 border; the fill behind the white label is painted outside the probe''s scope and is not declared'
    states: 'probe: neither tab changes on hover, pressed or focus'
    use: C-level / Advisor switch in the leadership section of /about/
  entity-link:
    type: button
    textColor: '#2d91ff'
    height: 28px
    typography: 18px / 700 / 28px Pretendard
    states: 'probe: hover and pressed show no change; focus shows only the browser''s default ring'
    use: 바로가기 links on the four KCD 공동체 company cards of /about/
  service-chip:
    type: badge
    textColor: '#192d82'
    border: '1px solid #192d82'
    rounded: 100px
    padding: 3px 25px
    height: 38px
    typography: 18px / 400 / 30px Pretendard
    use: Outlined label chips above the service introductions on /service/, 150 x 38
  carousel-arrow:
    type: button
    backgroundColor: '#192d82'
    textColor: '#ffffff'
    rounded: 50%
    size: 56px x 56px
    states: rest only; not probed
    use: Previous and next arrows of the service carousel on /service/
  cashnote-start-button:
    type: button
    backgroundColor: '#f4f7f9'
    textColor: '#2d91ff'
    rounded: 12px
    padding: 0px 12px
    height: 40px
    typography: 16px / 600 / 26px Pretendard
    states: 'probe: hover, pressed and focus (Tab #3) show no change'
    use: 'CashNote product site (cashnote.kr): 캐시노트 시작하기 in the header, 138 x 40'
  cashnote-download-button:
    type: button
    backgroundColor: '#f4f7f9'
    textColor: '#2d91ff'
    rounded: 16px
    padding: 0px 16px
    height: 48px
    typography: 19px / 700 / 26px Pretendard
    states: 'probe: hover, pressed and focus (Tab #5) show no change'
    use: 'CashNote product site (cashnote.kr): 앱 다운로드 in the hero, 118.5 x 48'
  cashnote-footer-download:
    type: button
    backgroundColor: '#f4f7f9'
    textColor: '#2d91ff'
    rounded: 12px
    padding: 12px 28px
    height: 40px
    typography: 16px / 600 / 16px Pretendard
    states: rest only; not probed
    use: 'CashNote product site (cashnote.kr): 앱 다운로드 in the closing band, 129 x 40'
fonts:
  roles:
    sans: Pretendard
---

# Korea Credit Data

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Korea Credit Data; reproduced for educational reference. Full prose: https://oh-my-design.kr/kcd/design.md
