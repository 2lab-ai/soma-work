---
name: Saramin
colors:
  primary: '#2d67ff'
  selected: '#2d65f2'
  link-hover: '#4875ef'
  focus-ring: '#3157dd'
  focus-ring-list: '#003fe5'
  ink: '#292e41'
  label: '#373f57'
  slate: '#475067'
  muted: '#5c667b'
  muted-alt: '#67738e'
  charcoal: '#444444'
  white: '#ffffff'
  surface: '#f4f6fa'
  tint: '#eff5ff'
  selected-tint: '#f0f4ff'
  highlight: '#fff7d6'
  sky-tint: '#ebfaff'
  hairline: '#d7dce5'
  divider: '#eaedf4'
typography:
  page-title:
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.13
    use: 'List-page title (h1.title_common, e.g. 지역별), 36px line, in #444444'
  banner-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.42
    use: 'Banner headings on the list pages (h2.tit_banner), 34px line, in #292e41'
  segment-tab:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: The two segmented tabs above the region list (a.BtnType), 28px line
  card-title:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.47
    use: 'Card titles in the home greeting panel (strong.card_title), 22px line, in #292e41'
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.29
    use: 'Home job-card text (a.link_box) and home tag badges, 18px line, in #292e41'
  tab:
    fontSize: 14px
    fontWeight: 700
    use: 'Selected and hovered list-tab labels (지역별, 직업별), in #2d65f2; unselected labels are 14px / 400 in #5c667b'
  button-sm:
    fontSize: 13px
    fontWeight: 700
    use: 'Header 기업서비스 label, in #373f57'
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: 'Card descriptions in the home greeting panel (p.card_desc), 18px line, in #67738e'
  meta:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: 'Posting meta lines on the list pages (location, career, education), 16px line, in #475067'
  badge:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 2
    use: Posting badges on the list pages, 24px line
rounded:
  tag: 4px
  overlay: 12px
  card: 16px
  button: 16px
  ai-pill: 20px
  circle: 20px
  search: 28px
spacing:
  badge-y: 2
  badge-x: 8
  button-x: 13
  tab-x: 16
  search-gap: 12
  card-pad: 24
components:
  search-field:
    type: button
    backgroundColor: transparent (on the white header)
    border: '2px solid #2d67ff'
    rounded: 28px
    height: 52px
    size: 554px x 52px
    focus: 'outline 2px solid #3157dd, offset 2px'
    states: 'probe on home: hover and pressed show no change across the field, its 4 descendants and 3 ancestor levels; transition all 0s'
    use: The keyword search field in the header of all three captured pages, labelled 공채는 역시, 사람인; it is a button that opens the search layer, with a 12px gap before the icon
  ai-search-button:
    type: button
    backgroundColor: linear-gradient(89deg, rgb(0, 161, 248) 0.78%, rgb(127, 56, 253) 99.22%)
    textColor: '#ffffff'
    rounded: 20px
    height: 40px
    typography: 14px / 700 / 20px Pretendard
    shadow: rgba(0, 161, 248, 0.3) 0px 0px 10px 0px
    focus: 'outline 2px solid #3157dd, offset 2px'
    states: 'hover and pressed are unmeasured: an animated gradient ::before layer never settled during the probe'
    use: AI 검색 beside the search field on all three pages, 86 x 40; it links to the AI career agent
  menu-button:
    type: button
    textColor: '#373f57'
    size: 60px x 40px
    hover: 'fg #2d67ff (label and both icons)'
    pressed: 'fg #2d67ff'
    focus: 'outline 2px solid #3157dd, offset 2px, radius 4px'
    states: hover and pressed settle at once (transition all 0s)
    use: 전체메뉴, the first button of the global navigation row on all three pages
  service-button:
    type: button
    backgroundColor: transparent
    textColor: '#373f57'
    border: '1px solid #d7dce5'
    rounded: 16px
    padding: 0px 13px
    height: 32px
    typography: 13px / 700 Pretendard
    hover: 'bg #f4f6fa'
    pressed: 'bg #f4f6fa'
    focus: 'outline 2px solid #3157dd, offset 2px'
    states: hover and pressed settle at once (transition all 0s)
    use: 기업서비스 in the header of all three pages, 98 x 32; bundle frames and the probe agree on the hover fill
  auth-link:
    type: button
    textColor: '#373f57'
    typography: 14px / 400 / 24px Pretendard
    hover: 'fg #4875ef'
    pressed: 'fg #4875ef'
    focus: 'outline 2px solid #3157dd, offset 2px, radius 4px'
    states: hover and pressed settle at once (transition all 0s); 회원가입 shows the same hover in bundle frames
    use: 로그인 and 회원가입 text links in the header; never followed
  carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    rounded: 20px
    size: 40px x 40px
    shadow: rgba(55, 63, 87, 0.13) 0px 6px 10px 0px
    focus: 'outline 2px solid #3157dd, offset 2px'
    states: hover and pressed show no change
    use: 다음 arrow of the home recruiting carousel, the one lifted control on the captured pages
  job-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #d7dce5'
    rounded: 16px
    padding: 15px 23px
    size: 300px x 270px
    use: 'Home job cards (a.link_box): 82 of 111 carry this 1px #d7dce5 border'
  featured-job-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #2d67ff'
    rounded: 16px
    padding: 23px
    size: 300px x 270px
    use: '28 of the 111 home job cards carry a 1px #2d67ff border instead; what distinguishes them was not established'
  posting-card:
    type: card
    border: '1px solid #d7dce5'
    rounded: 16px
    padding: 24px 24px 20px
    size: 404px x 208px
    use: Posting cards on both list pages (li.item, 16px radius, around a bordered link), also in a 300 x 230 variant
  greeting-link:
    type: card
    backgroundColor: '#f4f6fa'
    border: '1px solid #eaedf4'
    rounded: 16px
    padding: 17px 0px 17px 20px
    size: 296px x 60px
    hover: 'bg #ebfaff, border 1px solid rgba(2, 198, 255, 0.3)'
    states: hover read from settled bundle frames
    use: Tinted link rows in the home greeting panel (a.btn_greeting_link_my_siat)
  list-tab:
    type: tab
    textColor: '#5c667b'
    padding: 0px 16px
    height: 57px
    typography: 14px / 400 Pretendard
    selected: 'label #2d65f2 at 14px / 700 with a 2px #2d65f2 underline across the tab'
    hover: 'label #2d65f2 at weight 700'
    pressed: 'label #2d65f2 at weight 700'
    focus: 'outline 2px solid #003fe5, offset 2px, radius 4px'
    states: the selected tab shows no hover or pressed change; transition all 0s
    use: Sub-navigation of 채용정보 on the list pages (지역별, 직업별, 역세권별 and the rest), 68 x 57
  segment-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#475067'
    typography: 20px / 700 / 28px Pretendard
    size: 39px x 36px
    states: 'the first of the two tabs computes #475067 and the second #67738e; which one is selected is not recorded, and no pointer frame was read'
    use: Two-label segmented tabs above the region list on both list pages (a.BtnType)
  region-button:
    type: button
    textColor: '#292e41'
    height: 30px
    typography: 13px / 400 / 30px Pretendard
    selected: 'bg #f0f4ff on the current region (서울, the default)'
    focus: 'outline 2px solid #003fe5, offset 2px, radius 4px'
    states: 'hover and pressed are unmeasured: the pointer landed on the count span inside the button'
    use: Region rows in the list-page filter, each with a live posting count (서울 (62,552), 경기 (56,564))
  tag-badge:
    type: badge
    backgroundColor: '#eff5ff'
    textColor: '#292e41'
    rounded: 4px
    padding: 2px 8px
    height: 24px
    typography: 14px / 400 / 18px Pretendard
    use: Pale blue tags on home cards (38 instances)
  reward-badge:
    type: badge
    backgroundColor: '#fff7d6'
    textColor: '#292e41'
    rounded: 4px
    padding: 0px 6px
    height: 24px
    typography: 12px / 400 / 24px Pretendard
    use: Cream badges on list-page postings (span.badge.reward, 53 instances)
  meta-badge:
    type: badge
    backgroundColor: '#f4f6fa'
    textColor: '#475067'
    rounded: 4px
    padding: 0px 6px
    height: 24px
    typography: 12px / 400 / 24px Pretendard
    use: Grey badges on list-page postings (classes mActive, hot, invest, comInfo, welfare)
  overlay-badge:
    type: badge
    backgroundColor: rgba(0, 0, 0, 0.6)
    rounded: 12px
    padding: 2px 8px
    height: 24px
    use: Translucent dark badges laid over home card imagery (71 instances); their label sits in a child the collector did not record, so no label colour is declared
fonts:
  roles:
    body: Pretendard
---

# Saramin

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Saramin; reproduced for educational reference. Full prose: https://oh-my-design.kr/saramin/design.md
