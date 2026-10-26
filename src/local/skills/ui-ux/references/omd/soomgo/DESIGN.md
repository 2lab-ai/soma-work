---
name: Soomgo
colors:
  primary: '#693bf2'
  on-primary: '#ffffff'
  primary-hover: '#6302fb'
  primary-pressed: '#5400d7'
  ink: '#293341'
  heading: '#1c242f'
  slate: '#6a7685'
  muted: '#aab4bf'
  white: '#ffffff'
  surface: '#f6f7f9'
  surface-gray: '#eff1f5'
  hairline: '#e0e5eb'
  purple-tint: '#f1eeff'
typography:
  display-hero:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.38
    use: 'Hero headline on /pro, 72px line, in #ffffff'
  section-xl:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.28
    use: 'Section headings on /pro (four instances), 46px line, in #1c242f'
  search-title:
    fontSize: 34px
    fontWeight: 500
    letterSpacing: '-0.5px'
    use: 'Page title on /search/pro (Vite template), line-height normal, in #293341'
  section-lg:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.36
    use: 'Feature headings on /pro, 38px line, in #1c242f'
  title-lg:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: The large closing heading on home (#293341) and card headings on /pro (#ffffff), 32px line
  title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: 'Section headings on home (h2 and h4), 28px line, in #1c242f'
  lead:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.44
    use: 'Descriptions on /pro, 26px line, in #6a7685'
  body-strong:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: 'List titles and hero tab labels on home, 24px line, in #1c242f or #293341'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default on all three pages, 24px line, in #293341'
  label:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.57
    use: 'Short labels on home (prices, counts, card titles), 22px line, in #1c242f'
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: 'Meta and secondary text on home, 22px line, in #6a7685'
  button-sm:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Header 고수가입 label on home, 20px line
  badge:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Pro badge on /search/pro, 18px line, in #103580'
  fine:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: 'List meta on /search/pro, 18px line, in #6a7685'
rounded:
  xs: 4px
  cta: 6px
  ghost: 10px
  button: 12px
  ai: 15px
  chip: 16px
  card: 16px
  app: 20.5px
  saved: 22px
  filter: 28px
  region: 36px
spacing:
  chip-y: 8
  chip-x: 12
  cta-y: 7
  cta-x: 14
  card-y: 20
  card-x: 24
  button-x: 16
components:
  header-signup-button:
    type: button
    backgroundColor: '#693bf2'
    textColor: '#ffffff'
    border: '1px solid #693bf2'
    rounded: 6px
    padding: 7px 14px
    height: 36px
    typography: 14px / 500 / 20px Pretendard (served as the anonymised family font)
    hover: 'bg #5400d7'
    pressed: 'bg #5400d7'
    states: 'hover and pressed settle on #5400d7 after a 0.15s colour, border and background transition; focus (Tab #7) draws only the browser default ring'
    use: 고수가입 in the home header at home::[data-omd-capture="6"], 78 x 36
  search-header-signup-button:
    type: button
    backgroundColor: '#693bf2'
    textColor: '#ffffff'
    border: '1px solid #693bf2'
    rounded: 6px
    padding: 6.5px 0px
    height: 36px
    typography: 14px / 500 / 21px Pretendard
    hover: 'bg #4e17f0, border #4710ea'
    pressed: 'bg #5400d7, border #5400d7'
    focus: 'bg #5400d7, border #5400d7'
    states: 'the older /search/pro template: hover, pressed and focus read by the probe on a real Tab; the button transitions opacity 0.2s'
    use: 고수가입 in the /search/pro header at surface-2::[data-omd-capture="6"], a fixed 80 x 36 button
  primary-cta:
    type: button
    backgroundColor: '#693bf2'
    textColor: '#ffffff'
    rounded: 12px
    padding: 0px 16px
    height: 52px
    typography: 16px / 600 label (Pretendard, served as font)
    hover: 'bg #6302fb'
    pressed: 'bg #5400d7'
    states: hover and pressed settle after a 0.2s background-color transition; focus draws only the browser default ring
    use: 'Large purple actions: 고수가입 near the foot of home (155 x 52, home::[data-omd-capture="152"]) and 고수 가입하기 in the /pro hero (224 x 52); 필요한 정보 보러 가기 on /pro repeats it at 143 x 44 with 0px 12px padding and a 14px / 600 label'
  text-cta:
    type: button
    backgroundColor: transparent
    textColor: '#693bf2'
    rounded: 10px
    padding: 0px 12px
    height: 38px
    typography: 14px / 600 label
    hover: 'bg #f6f7f9'
    pressed: 'bg #eff1f5'
    states: 'hover and pressed settle after a 0.2s background-color transition; focus (Tab #24) draws only the browser default ring'
    use: 지금 가입하고 혜택 받기 on /pro at surface-3::[data-omd-capture="12"], 175 x 38
  app-download-button:
    type: button
    backgroundColor: '#693bf2'
    textColor: '#ffffff'
    rounded: 20.5px
    padding: 0px 16px
    height: 36px
    typography: 12px / 500 / 36px
    states: hover and pressed unmeasured (the pointer did not match :hover); focus draws only the browser default ring
    use: APP STORE and PLAY STORE in the footer of all three pages at home::[data-omd-capture="156"], 136 x 36 (padding 1px 16px on /search/pro)
  ai-quote-button:
    type: button
    backgroundColor: '#f6f7f9'
    textColor: '#1c242f'
    rounded: 15px
    padding: 12px
    height: 46px
    typography: 14px / 600 label
    states: 'the button''s own fill never changes; its icon animates and a wrapper paints a rotating conic-gradient that starts at #693bf2, so no settled hover or pressed value is declared; focus (Tab #21) draws only the browser default ring'
    use: AI 견적 요청 beside the home search field at home::[data-omd-capture="9"], 108 x 46
  category-chip:
    type: button
    backgroundColor: transparent
    textColor: '#1c242f'
    border: '1px inset ring #e0e5eb (box-shadow 0 0 0 1px inset)'
    rounded: 16px
    padding: 8px 12px
    height: 32px
    typography: 14px / 400 / 16px label
    selected: 'bg #293341, label #ffffff, no ring'
    states: hover and pressed show no change on either variant; focus draws only the browser default ring
    use: Service category chips on home (헤어/메이크업, 영어 과외 …) at home::[data-omd-capture="28"]; the selected chip (이사/입주 청소업체, 과외) at home::[data-omd-capture="27"]
  region-chip:
    type: button
    backgroundColor: '#f6f7f9'
    textColor: '#693bf2'
    rounded: 36px
    height: 36px
    typography: 14px / 400 label
    states: hover and pressed show no change within the probe's scope; focus not measured
    use: Region links (서울, 경기, 부산 … 16 regions) on home at home::[data-omd-capture="136"], 58 x 36 with a 36px line box
  load-more-button:
    type: button
    backgroundColor: '#eff1f5'
    textColor: '#1c242f'
    rounded: 12px
    padding: 0px 12px
    height: 44px
    typography: 14px / 600 label
    hover: 'bg #e0e5eb'
    pressed: 'bg #c7ced6'
    states: 'hover and pressed settle after a 0.2s background-color transition; focus (Tab #97) draws only the browser default ring'
    use: 이 고수의 작업 사례 더보기 under a pro's portfolio on home at home::[data-omd-capture="85"], 300 x 44
  hero-tab:
    type: tab
    textColor: '#1c242f'
    height: 48px
    padding: 8px 4px
    typography: 16px / 600 / 24px label
    selected: 'aria-selected tab label #1c242f; the unselected label is #aab4bf'
    states: selected and unselected read from rest values; the collector's tab interaction recorded the selected state
    use: 견적비교 and 바로예약 tabs under the home search at home::[data-omd-capture="10"], 192 x 48
  search-input:
    type: input
    backgroundColor: '#eff1f5'
    textColor: '#293341'
    rounded: 4px 0px 0px 4px
    padding: 10px 16px 10px 40px
    height: 44px
    typography: 16px / 400 / 24px Pretendard
    states: 'hover, pressed and focus (Tab #13) show no change within the probe''s scope (self and 3 ancestor levels), although the field declares a 0.15s border-color and box-shadow transition'
    use: '어떤 서비스가 필요하세요? search field on /search/pro at surface-2::[data-omd-capture="12"], 497 x 44, joined to a #eff1f5 지도 button on its right'
  filter-button:
    type: button
    backgroundColor: transparent
    textColor: '#6a7685'
    border: '1px solid #e0e5eb'
    rounded: 28px
    padding: 7px 16px 9px
    height: 40px
    typography: 16px / 400 / 24px Pretendard
    states: 'hover, pressed and focus (Tab #9) show no change within the probe''s scope'
    use: 서비스 and 지역 filter buttons on /search/pro at surface-2::[data-omd-capture="8"], 99 x 40
  saved-pros-button:
    type: button
    backgroundColor: '#293341'
    textColor: '#ffffff'
    border: '1px solid #e0e5eb'
    rounded: 22px
    padding: 9px 16px 10px
    height: 45px
    typography: 16px / 500 / 24px Pretendard
    hover: 'border #c1cbd7'
    pressed: 'bg #c1cbd7, label #293341, border #b9c5d2'
    focus: 'border #c1cbd7'
    states: read by the probe on /search/pro, including a real Tab
    use: 찜한 고수 on /search/pro at surface-2::[data-omd-capture="41"], 119 x 45
  ad-pro-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 20px 24px
    shadow: rgba(41, 51, 65, 0.08) 0px 4px 12px 0px, rgba(41, 51, 65, 0.06) 0px 0px 2px 0px
    size: 630px x 148px
    use: Sponsored pro cards at the top of the /search/pro list at surface-2::[data-omd-capture="15"]
  pro-card:
    type: card
    border: '1px solid #eff1f5'
    rounded: 16px
    size: 354px x 208px
    use: Recommended-pro cards in a carousel on home (five captured), at home::[data-omd-capture="56"]
  pro-badge:
    type: badge
    backgroundColor: '#e7f4ff'
    textColor: '#103580'
    rounded: 4px
    padding: 2px 4px
    typography: 12px / 500 / 18px Pretendard
    use: Pro badges in the /search/pro list (18 instances), 69 x 22
  pay-chip:
    type: badge
    backgroundColor: '#f1eeff'
    rounded: 4px
    padding: 3px 5px
    use: 숨고페이 chips in the /search/pro list (23 instances); the chip's label child was not recorded, so no label colour is declared
fonts:
  roles:
    sans: Pretendard
---

# Soomgo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Soomgo; reproduced for educational reference. Full prose: https://oh-my-design.kr/soomgo/design.md
