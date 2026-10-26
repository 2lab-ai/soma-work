---
name: Tabling
colors:
  primary: '#fc3d0e'
  primary-end: '#fc5c17'
  on-primary: '#fbfcfd'
  ink: '#2e3137'
  heading: '#000000'
  ink-strong: '#11181c'
  rating: '#131517'
  slate: '#505c81'
  muted: '#6d7583'
  label-grey: '#525965'
  faint: '#969fac'
  inactive: '#b7bec8'
  waiting: '#1cfbce'
  info: '#0d74f6'
  white: '#ffffff'
  surface: '#f1f3f5'
  region: '#f0f4ff'
  divider: '#f3f5f8'
  border: '#d7dbdf'
typography:
  hero:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: 'Home hero heading (오늘 뭐 먹지? 맛집 검색은 테이블링), 31.992px line, in #000000'
  name:
    fontSize: 22px
    fontWeight: 700
    use: 'Restaurant name on the restaurant page, normal line height, in #11181c'
  section:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.3
    use: 'Home section headings (지역별 인기 웨이팅 맛집 in #000000; curation titles in #11181c), 26px line'
  card-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.22
    use: 'Restaurant names on TOP100 cards, 22px line, in #2e3137'
  cta:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.33
    use: 'Label of 테이블링 앱에서 이용하기, 24px line, in #fbfcfd; the button computes Arial, not Pretendard'
  search:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.19
    use: 'Store search input on home, 19.088px line, in #000000'
  tab:
    fontSize: 16px
    fontWeight: 700
    use: 'Selected tab of the restaurant page (#11181c); unselected tabs are 600 in #b7bec8'
  body:
    fontSize: 14px
    fontWeight: 400
    use: 'Document default on all three routes, normal line height, in #2e3137'
  desc:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.1px'
    use: Restaurant introduction on the restaurant page, 21px line
  subtitle:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.29
    use: 'Home curation subtitles, 18px line, in #6d7583'
  footer-link:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Footer links, 21px line, in #6d7583'
  meta:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: 'Cuisine and area line on TOP100 cards, 18px line, in #6d7583'
  rating:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.38
    use: 'Rating value on TOP100 cards, 18px line, in #131517'
  option:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.38
    use: 'Service options on TOP100 cards, 18px line, in #505c81'
  badge:
    fontSize: 12px
    fontWeight: 700
    use: 'Live waiting-team count on TOP100 thumbnails, in #1cfbce'
  tag:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.33
    use: 'Tag chips on the restaurant page, 16px line, in #525965'
  label:
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.27
    use: 'Grey labels on TOP100 cards, 14px line, in #505c81'
  rank:
    fontSize: 12px
    fontWeight: 900
    letterSpacing: '-0.5px'
    use: 'Rank numerals over TOP100 thumbnails, in #ffffff'
rounded:
  label: 4px
  thumb: 8px
  cta: 10px
  slot: 12px
  chip: 16px
  region: 24px
spacing:
  card: 16
  region-y: 8
  region-x: 16
  tag-y: 8
  tag-x: 12
  label-y: 4
  label-x: 6
  cta-top: 19
  cta-bottom: 17
  bar-y: 8
  bar-x: 14
components:
  app-cta:
    type: button
    backgroundColor: 'linear-gradient(90deg, #fc3d0e, #fc5c17)'
    textColor: '#fbfcfd'
    rounded: 10px
    padding: 19px 0px 17px
    height: 60px
    typography: 18px / 700 / 24px; the button computes Arial (the browser default for buttons), so Hangul falls back to the system face
    states: 'probe: hover and pressed show no change across the button and three ancestor levels (transition all 0s); focus draws only the browser default ring, so no brand focus style is declared'
    use: 테이블링 앱에서 이용하기, fixed at the bottom of the restaurant page at surface-3::[data-omd-capture="11"], 520.3 x 60, on a white 600 x 76 bar with 8px 14px padding; the gradient is the button's own background-image
  region-button:
    type: button
    backgroundColor: '#f0f4ff'
    textColor: '#2e3137'
    border: 1px solid rgba(0, 0, 0, 0.04)
    rounded: 24px
    padding: 8px 16px
    size: 80px x 80px
    typography: 14px / 400 (computes Arial)
    states: rest only; not probed
    use: Region shortcuts under 지역별 인기 웨이팅 맛집 on home (전국, 서울 남부, 서울 북부, 부산, 경남, 광주, 강원, 대구) at home::[data-omd-capture="11"]
    height: 80px
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  category-button:
    type: button
    backgroundColor: transparent
    textColor: '#2e3137'
    size: 142px x 72px
    typography: 14px / 400 (computes Arial), 6px gap between icon and label
    states: rest only; not probed
    use: Cuisine shortcuts under the hero search on home (한식, 일식, 양식, 중식, 카페/베이커리, 해산물, 주점, 기타) at home::[data-omd-capture="3"], an icon over a label
  chart-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0d74f6'
    border: '1px solid #0d74f6'
    rounded: 8px
    height: 44px
    typography: 14px / 700 (computes Arial)
    states: 'probe: hover and pressed show no change (transition all 0s); focus draws only the browser default ring'
    use: 앱에서 대기시간 확인하기 over the waiting-time chart on the restaurant page at surface-3::[data-omd-capture="4"], 200 x 44
  copy-button:
    type: button
    backgroundColor: '#f1f3f5'
    textColor: '#525965'
    rounded: 16px
    padding: 10px 12px
    height: 34px
    typography: 11px / 600 / 14px (computes Arial)
    states: 'probe: hover and pressed show no change (transition all 0s); focus draws only the browser default ring'
    use: 주소복사 beside the address on the restaurant page at surface-3::[data-omd-capture="10"], 78 x 34
  detail-tab:
    type: tab
    textColor: '#b7bec8'
    padding: 12px 0px
    height: 46px
    typography: 16px / 600 Pretendard
    selected: 'fg #11181c at weight 700, 45px tall, with a 2px top border computed in #11181c'
    states: 'probe on 리뷰 10,364: hover and pressed show no change; the tab is not in the Tab order (tabIndex -1); selected variant read from rest values'
    use: 'Tabs of the restaurant page (the selected first tab, whose panel components are named Home_*, and 리뷰 10,364), 200px wide each, on a sticky white header over an 8px #f3f5f8 divider'
  time-slot:
    type: toggle
    textColor: '#6d7583'
    padding: 3px 12px
    typography: 12px / 500 / 16px Pretendard
    selected: 'bg #ffffff, fg #525965 at weight 700, radius 12px, box-shadow rgba(109, 117, 131, 0.04) 0px 4px 12px 0px, rgba(109, 117, 131, 0.04) 0px -4px 24px 0px'
    states: selected variant read from rest values; no pointer frame
    use: Time selector of the waiting-time chart on the restaurant page, 75 x 22 cells (7 captured)
  tag-chip:
    type: badge
    textColor: '#525965'
    border: '1px solid #d7dbdf'
    rounded: 16px
    padding: 8px 12px
    height: 34px
    typography: 12px / 500 / 16px Pretendard
    use: Tags in the restaurant page's first tab panel (class Home_tag), 102 x 34 (8 captured)
  waiting-badge:
    type: badge
    backgroundColor: rgba(0, 0, 0, 0.8)
    textColor: '#ffffff'
    count: '#1cfbce at 12px / 700'
    rounded: 0px 0px 8px 8px
    size: 88px x 28px
    typography: 12px / 700 Pretendard
    use: 'Live waiting overlay across the foot of each TOP100 thumbnail; the team count inside is set in #1cfbce (13 of 20 captured cards)'
  contract-label:
    type: badge
    backgroundColor: '#f1f3f5'
    textColor: '#505c81'
    rounded: 4px
    padding: 4px 6px
    height: 22px
    typography: 11px / 600 / 14px Pretendard
    use: Small grey labels on TOP100 cards, 50 x 22 (30 captured)
  store-card:
    type: card
    backgroundColor: '#ffffff'
    padding: 16px
    size: 600px x 150px
    use: 'TOP100 ranking card: thumbnail beside the name, rating, review count, cuisine and area, and options (20 captured)'
  thumbnail:
    type: card
    border: 1px solid rgba(0, 0, 0, 0.04)
    rounded: 8px
    size: 90px x 102px
    use: Restaurant thumbnail frame on TOP100 cards, with the rank numeral and the waiting overlay on it
  map-button:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.44)
    textColor: '#ffffff'
    rounded: 4px
    padding: 6px 8px
    height: 28px
    typography: 13px / 500 / 16px (computes Arial)
    states: rest only; not probed
    use: Map-view button (class Home_mapViewButton) over the map on the restaurant page at surface-3::[data-omd-capture="9"], 61 x 28
  search-input:
    type: input
    textColor: '#000000'
    typography: 16px / 600 / 19.088px Pretendard
    states: rest only; not probed
    use: Store search input under the hero heading on home at home::[data-omd-capture="2"], 524 x 19, beside a 24 x 24 search button
fonts:
  roles:
    ui: Pretendard
---

# Tabling

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Tabling; reproduced for educational reference. Full prose: https://oh-my-design.kr/tabling/design.md
