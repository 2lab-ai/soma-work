---
name: Shift Up
colors:
  primary: '#569a43'
  ink: '#000000'
  white: '#ffffff'
  body: '#777777'
  surface: '#f4f4f4'
  hairline: '#dddddd'
typography:
  display-xl:
    fontSize: 80px
    fontWeight: 700
    lineHeight: 1.15
    use: RECRUIT banner heading on the recruit page, Roboto Condensed, 92px line, white over the banner image
  display:
    fontSize: 50px
    fontWeight: 700
    lineHeight: 1.2
    use: Section headings on home, Roboto Condensed, 60px line, white over key art
  list-head:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-1.2px'
    use: 'Recruit list heading (the current category name), Pretendard, 42px line, #000000'
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.96px'
    use: 'Job posting titles on the recruit list (44 instances), Pretendard, 36px line, #000000'
  game-title:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '-0.96px'
    use: Game names on the games page and home game panels, Pretendard, 36px line, white
  news-title:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.8px'
    use: News headlines on home, Pretendard, 32px line, white
  lead:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: '-0.72px'
    use: Game descriptions on the games page, Pretendard, 30.6px line, white
  nav:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0.36px
    use: Header navigation (ABOUT, GAMES, RECRUIT, NEWS, IR, CONTACT), Roboto Condensed, 21.6px line
  tab:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: '-0.72px'
    use: Recruit category list items, Pretendard, 21.6px line; the selected item is weight 600
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: 'Document default, Pretendard, 25.6px line, #777777'
  slider-tab:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.32px
    use: Selected game tab of the home hero slider, Roboto Condensed, 24px line; unselected tabs weight 400
  link:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: '-0.47px'
    use: 'Footer legal links (개인정보처리방침, 공익신고자 보호방침), Pretendard, 25.6px line, #569a43'
rounded:
  none: 0px
  arrow: 30px
spacing:
  nav-y: 35
  nav-x: 16
  tab-y: 18
  tab-x: 30
  field-x: 20
  field-inset: 60
components:
  slider-arrow:
    type: button
    backgroundColor: '#569a43'
    textColor: '#ffffff'
    rounded: 30px 0px 0px (top-left only) on the previous arrow; 0px 30px 0px 0px (top-right only) on the next arrow
    size: 90px x 90px
    hover: 'bg #ffffff, icon #569a43'
    pressed: 'bg #ffffff, icon #569a43'
    states: hover and pressed invert the arrow to a white square with a green icon after a 0.3s linear transition; focus shows no change on the control; the icon is drawn by ::after
    use: Previous and next arrows of the games slider on home (button.slick-prev at home::[data-omd-capture="29"], button.slick-next at capture 35)
  outline-link:
    type: button
    textColor: '#ffffff'
    border: '2px solid #ffffff'
    rounded: 0px
    height: 60px
    size: 180px x 60px
    hover: 'a fill sweeps across from the ::before layer (0 to 352px wide) and the label turns #000000'
    pressed: same as hover
    states: hover and pressed after a 0.4s linear transition; focus draws only the browser's default ring, so no brand focus style is declared
    use: 프로젝트 소개 and 채용 지원 on the game panels of the games page (surface-2::[data-omd-capture="27"]) and home; the label is a child em, and its font was not recorded, so no font is declared
  nav-item:
    type: tab
    textColor: '#ffffff'
    typography: 18px / 500 / 21.6px Roboto Condensed, letter-spacing 0.36px
    padding: 35px 16px 34px
    height: 91px
    hover: 'label #000000 and a 3px ::after bar grows to the item''s full width'
    pressed: same as hover
    states: 'hover and pressed after a 0.3s linear transition; on the light recruit header the label rests at #000000 and only the bar grows; the bar''s colour is outside the probe''s compared values and is not declared; focus draws only the browser ring'
    use: Header navigation over the home and games heroes at home::[data-omd-capture="4"]
  category-tab:
    type: tab
    textColor: '#777777'
    border: '0px 0px 1px solid #dddddd'
    typography: 18px / 400 / 21.6px Pretendard, letter-spacing -0.72px
    padding: 18px 30px 16px 0px
    height: 57px
    selected: 'fg #569a43, weight 600'
    hover: 'fg #569a43 and a 2px ::before bar grows across the full 313px width'
    pressed: same as hover
    states: the selected item shows no change on hover or pressed; the probed unselected item (사업) turns green after a 0.3s linear transition; focus draws only the browser ring
    use: 'Recruit category list (전체, 스텔라 블레이드 차기작, 승리의 여신: 니케, 프로젝트 스피릿, 사업, 경영지원 and others) at surface-3::[data-omd-capture="36"], 313 x 57'
  sub-nav-tab:
    type: tab
    textColor: '#ffffff'
    typography: 18px / 400 / 70px Pretendard, letter-spacing -0.72px
    height: 70px
    selected: 'fg #569a43, weight 600'
    hover: 'fg #569a43'
    pressed: 'fg #569a43'
    states: the selected tab shows no change; the other turns green on hover and pressed after a 0.3s linear transition; focus draws only the browser ring
    use: 채용안내 and 채용공고 over the recruit banner at surface-3::[data-omd-capture="30"]
  search-input:
    type: input
    backgroundColor: '#f4f4f4'
    textColor: '#000000'
    rounded: 0px
    padding: 0px 60px 0px 20px
    height: 60px
    typography: 16px / 400 Pretendard
    states: 'probe: hover, pressed and focus show no change; transition all 0s'
    use: Recruit search field (placeholder 검색어를 입력해주세요.) at surface-3::[data-omd-capture="33"], 375 x 60, with a 60 x 60 search button inside its right inset
  slider-tab:
    type: tab
    textColor: '#ffffff'
    typography: 16px / 700 / 24px Roboto Condensed, letter-spacing 0.32px
    padding: 0px 15px
    selected: 'weight 700 in #ffffff; unselected tabs are weight 400 in white at 50% opacity'
    states: selected read from the slider's state at capture; no pointer frame
    use: Game tabs of the home hero slider at home::#slick-slide00
  footer-legal-link:
    type: button
    textColor: '#569a43'
    typography: 16px / 700 / 25.6px Pretendard, letter-spacing -0.47px
    hover: a 2px underline sweeps in from the ::before layer
    pressed: same as hover
    states: hover and pressed after a 0.7s transition; focus draws only the browser ring
    use: 개인정보처리방침 and 공익신고자 보호방침 in the footer of all three pages at home::[data-omd-capture="52"]
fonts:
  roles:
    display: Roboto Condensed
    body: Pretendard
---

# Shift Up

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Shift Up; reproduced for educational reference. Full prose: https://oh-my-design.kr/shiftup/design.md
