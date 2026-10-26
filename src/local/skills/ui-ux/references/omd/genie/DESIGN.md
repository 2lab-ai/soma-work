---
name: Genie Music
colors:
  primary: '#0096ff'
  heading: '#27282d'
  body: '#444444'
  secondary: '#666666'
  muted: '#8b8b8b'
  muted-alt: '#969697'
  outline: '#a6afb6'
  border: '#cccccc'
  surface: '#f6f6f6'
  white: '#ffffff'
typography:
  gnb:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Global navigation items (지니차트, 최신음악, 장르음악 and the rest), 27px line, in #27282d; declared family Malgun Gothic, unresolved in the capture environment'
  section-title:
    fontSize: 18px
    fontWeight: 700
    use: 'Home section titles (h2.sub-title), line-height normal, in #27282d; declared family Malgun Gothic, unresolved in the capture environment'
  menu:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.71
    use: '로그인/회원가입 in the header, 24px line, in #444444'
  body:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default on all three pages, 18px line, in #444444; declared family dotum, unresolved in the capture environment'
  row:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.83
    use: Chart and list rows (artist names), 22px line
  tab:
    fontSize: 12px
    fontWeight: 700
    use: Selected chart scope tab (종합) and the 웹플레이어 link, line-height normal
  caption:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    use: 'DJ names on home, 16.5px line, in #969697'
  category:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 2
    use: 'NEW ALBUM category labels on home, 22px line, in #0096ff'
  button-sm:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 2.09
    use: Outlined row-button labels (전체듣기 and its partners), 23px line
rounded:
  square: 0px
  toggle: 3px
  control: 4px
spacing:
  tab-x: 8
  gnb-gap: 27
  chart-tab-top: 11
  chart-tab-x: 14
  row-button-x: 6
  row-button-icon: 26
  filter-x: 8
components:
  gnb-menu:
    type: tab
    textColor: '#27282d'
    padding: 0px 27px 14px 0px
    height: 38px
    typography: 18px / 700 / 27px; declared family Malgun Gothic, unresolved in the capture environment
    hover: 'fg #0096ff'
    pressed: 'fg #0096ff'
    focus: 'fg #0096ff plus a 1px dotted #0096ff outline'
    states: 'probe on 지니차트 (home; the other seven items share the gnb-menu class): hover and pressed settle on #0096ff after a 0.15s colour transition; focus (Tab #27) turns the label #0096ff and draws a 1px dotted outline in that colour'
    use: Global navigation (지니차트, 최신음악, 장르음악, 뮤직비디오, 영상, 추천, 매거진, 뮤직허그) on all three pages at home::[data-omd-capture="9"], 58-89 x 38
  chart-scope-tab:
    type: tab
    textColor: '#8b8b8b'
    padding: 0px 8px
    height: 15px
    typography: 12px / 400
    selected: 'fg #0096ff, 12px / 700'
    focus: '1px dotted outline in the label colour (#0096ff selected, #8b8b8b unselected)'
    states: 'probe on home: hover shows no change on the selected or an unselected tab; pressed and focus (Tabs #69 and #70) draw only the dotted outline; transition all 0s'
    use: Chart scope tabs on home (종합 selected, 국내 and a third tab) and the tab pair under a lower section heading (추천 selected), 37 x 15
  web-player-link:
    type: button
    textColor: '#0096ff'
    height: 18px
    typography: 12px / 700
    hover: 'underline in #0096ff'
    pressed: 'underline in #0096ff'
    focus: '1px dotted #0096ff outline'
    states: 'probe on home: hover and pressed add a solid #0096ff underline; focus (Tab #7) draws a 1px dotted #0096ff outline'
    use: 웹플레이어 in the header utility row of all three pages, 60 x 18
  purchase-link:
    type: button
    textColor: '#444444'
    padding: 0px 4px 0px 26px
    height: 18px
    typography: 12px / 700 / 18px
    hover: 'underline in #444444'
    pressed: 'underline in #444444'
    focus: '1px dotted #444444 outline'
    states: 'probe on home: hover and pressed add a solid underline; focus (Tab #4) draws a 1px dotted outline in the label colour'
    use: 이용권 구매 in the header utility row of all three pages, 85 x 18; the 26px left padding holds an icon the collector does not read
  outlined-row-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#27282d'
    border: '1px solid #a6afb6'
    rounded: 4px
    padding: 0px 6px 0px 26px
    height: 24px
    typography: 11px / 400 / 23px
    hover: 'border #27282d'
    pressed: 'border #27282d'
    focus: '1px dotted #27282d outline'
    states: 'probe on 전체듣기 (home): hover and pressed darken the border from #a6afb6 to #27282d; focus (Tab #144) draws a 1px dotted #27282d outline'
    use: '전체듣기, 담기, 앨범 and 다운 buttons above chart lists: 72 x 24 on home at home::[data-omd-capture="97"], 53-97 x 24 on /chart/top200; the icon sits in the 26px left padding'
  more-button:
    type: button
    backgroundColor: '#f7f8f9'
    textColor: '#27282d'
    border: '1px solid #f7f8f9'
    rounded: 4px
    padding: 0px 22px 2px 0px
    height: 40px
    typography: 14px / 400; declared family Malgun Gothic, unresolved in the capture environment
    states: rest only; not probed, no state frame
    use: 컨텐츠 더보기 under the editor section on home, 168 x 40
    pressed: 'outline #27282d dotted 1px (:hover + :active)'
    focus: 'outline #27282d dotted 1px on :focus-visible'
  chart-type-tab:
    type: tab
    backgroundColor: '#f6f6f6'
    textColor: '#444444'
    padding: 11px 14px 0px
    height: 37px
    typography: 12px / 400 / 18px
    selected: 'bg #ffffff on the current tab (109 x 38)'
    states: selected variant read from rest values; not probed
    use: 'Chart-type tabs across the top of /chart/top200 and /newest/song, 110-120 x 37, set in a 710px #f6f6f6 strip'
  period-toggle:
    type: tab
    backgroundColor: '#fafafa'
    textColor: '#656565'
    border: '1px solid #cccccc on top and bottom; the last segment also closes its right side'
    rounded: 0px; 3px on the two outer corners
    height: 22px
    typography: 11px / 400 / 22px
    selected: 'bg #a5a5a5, fg #ffffff, border 1px #9c9c9c, 11px / 700, inset shadow rgba(0, 0, 0, 0.05) 1px 1px 0px 0px'
    states: selected variant read from rest values; not probed
    use: Segmented period control 실시간 / 일간 / 주간 / 월간 / 누적 on /chart/top200; segments 47 x 22, the selected 실시간 59 x 22
  count-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#656565'
    border: '1px solid #cccccc'
    rounded: 3px
    height: 22px
    typography: 11px / 400 / 21px
    states: rest only; not probed; it opens a layer and was not clicked
    use: 집계기준 beside the period control on /chart/top200, 66 x 22
  rank-toggle:
    type: tab
    textColor: '#8b8b8b'
    padding: 0px 0px 0px 13px
    height: 15px
    typography: 12px / 400
    selected: 'fg #d62952, 12px / 700'
    states: selected variant read from rest values; not probed
    use: 1위 / 2위 toggle beside 실시간 차트 점유율 그래프 on /chart/top200, 40 x 15
  genre-filter:
    type: tab
    textColor: '#444444'
    padding: 1px 8px
    height: 20px
    typography: 12px / 400 / 18px
    selected: 'fg #f68074, 12px / 700 (HOT)'
    states: selected variant read from rest values; not probed
    use: 앨범 종류 filter on /newest/song (HOT, 전체, 가요, POP, OST, 트롯, JAZZ, CLASSIC, EDM, 동요/태교, JPOP, 뉴에이지, CCM, 그 외 장르)
  pagination:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#666666'
    border: '1px solid #cccccc'
    rounded: 4px
    size: 28px x 28px
    typography: 12px / 400 / 26px; declared family Tahoma, unresolved in the capture environment
    selected: 'fg #0096ff, border 1px solid #0096ff, 12px / 700'
    states: selected variant read from rest values; not probed
    use: Page numbers under the /newest/song list
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#444444'
    padding: 1px 2px
    height: 38px
    typography: 14px / 400; declared family Malgun Gothic, unresolved in the capture environment
    states: rest only; not probed; nothing was typed
    use: Header search field on all three pages, 322 x 38; the input computes no border and no radius, so the visible frame belongs to an element the collector did not record and is not declared
  login-button:
    type: button
    textColor: '#444444'
    padding: 0px 18px 0px 5px
    height: 22px
    typography: 14px / 400 / 24px
    states: rest only; not probed; it opens a menu and was not clicked
    use: 로그인/회원가입 toggle in the header of all three pages, 112 x 22
---

# Genie Music

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Genie Music; reproduced for educational reference. Full prose: https://oh-my-design.kr/genie/design.md
