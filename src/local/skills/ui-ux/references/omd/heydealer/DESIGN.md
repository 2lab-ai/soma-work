---
name: Heydealer
colors:
  primary: '#396eff'
  on-primary: '#ffffff'
  ink: '#0c0d11'
  black: '#000000'
  canvas: '#ffffff'
  dark: '#101115'
typography:
  display:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-1.008px'
    use: The largest heading on /sell (an h2)
  hero:
    fontSize: 32px
    fontWeight: 700
    use: The /sell hero heading (최대 50개 견적, 최고가 그대로 내차팔기); line height normal
  page-title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.36
    letterSpacing: '-0.728px'
    use: 모든 차량 at the top of home (h1)
  section:
    fontSize: 24px
    fontWeight: 700
    use: Listing section headings on home (할인 중, eye 인증 차량, 오늘 가장 많이 조회된 차량); line height normal
  subsection:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: 타 본 사람들 이야기 on home; 자주 묻는 질문 and 판매후기 on /sell
  card-head:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.44
    letterSpacing: '-0.252px'
    use: '헤이딜러가 인증 했어요, 인기 모델 and the section links on home, in #000000'
  emphasis:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.47
    letterSpacing: '-0.195px'
    use: Car names, sale-step titles, header navigation and the primary button label
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.195px'
    use: Owner-review paragraphs on home
  text:
    fontSize: 16px
    fontWeight: 400
    use: Default text, chips and selects; line height normal
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: 0.078px
    use: Small outlined buttons and footer links
  label:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.38
    letterSpacing: 0.078px
    use: 인기 검색 and small card labels on home
  fine:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.12px
    use: Notes under the /sell step cards
rounded:
  base: 4px
  card: 8px
  switch: 16px
  pill: 100px
spacing:
  chip-y: 8
  chip-x: 12
  button-x: 24
  select-y: 16
  card: 16
components:
  primary-button:
    type: button
    backgroundColor: '#396eff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 24px
    height: 56px (52px on /sell)
    typography: 15px / 700 / 22px spoqaHanSansNeo, tracking -0.195px
    states: rest on both captured instances; no hover or pressed frame was recorded, so no state value is declared
    use: The count-and-보기 action under the brand, type and model selects on home (132 x 56) at home::[data-omd-capture="14"], and 10초 만에 확인 on /sell (280 x 52, surface-3 capture 10)
  select-button:
    type: button
    backgroundColor: rgba(97, 113, 159, 0.08)
    textColor: '#0c0d11'
    border: 1px solid transparent
    rounded: 4px
    padding: 16px 24px
    height: 56px
    typography: 16px / 400 spoqaHanSansNeo
    disabled: '차종 선택 and 모델 선택 were disabled at capture (captures 12 and 13) and compute the same rgba(97, 113, 159, 0.08) fill and #0c0d11 text as the enabled select'
    states: 'expanded: the collector opened 브랜드 전체 and read the brand menu'
    use: 브랜드 전체, 차종 선택 and 모델 선택 on home (240 x 56) at home::[data-omd-capture="11"]
  search-trigger:
    type: button
    backgroundColor: rgba(97, 113, 159, 0.08)
    textColor: '#0c0d11'
    rounded: 4px
    padding: 0px 16px
    height: 52px
    typography: 16px / 400 spoqaHanSansNeo
    states: rest only; it was not opened
    use: 모델을 입력해주세요. in the header of home and /market/cars (240 x 52) at home::[data-omd-capture="9"]
  nav-button:
    type: tab
    backgroundColor: transparent
    textColor: rgba(38, 55, 97, 0.6)
    rounded: 4px
    padding: 8px
    height: 38px
    typography: 15px / 700 / 22px spoqaHanSansNeo, tracking -0.195px
    selected: 'fg #0c0d11 on the current section (내차사기 on /market/cars, 내차팔기 on /sell)'
    states: selected read from rest values across the three pages; no pointer frame
    use: 내차사기, 내차팔기, 폐차 견적받기 and 중고차 숨은 이력 in the header at home::[data-omd-capture="2"]
  filter-chip:
    type: button
    backgroundColor: transparent
    textColor: '#0c0d11'
    border: 1px solid rgba(97, 113, 159, 0.16)
    rounded: 4px
    padding: 8px 12px
    height: 36px
    typography: 16px / 400 spoqaHanSansNeo
    states: rest only; no filter panel was opened
    use: 전체 필터, eye 인증, 할인 중, 연식, 주행거리, 가격 and the other filters on /market/cars at surface-2::[data-omd-capture="42"]
  radio-chip:
    type: toggle
    backgroundColor: transparent
    textColor: '#0c0d11'
    border: 1px solid rgba(97, 113, 159, 0.16)
    rounded: 4px
    padding: 8px 12px
    height: 36px
    typography: 16px / 400 spoqaHanSansNeo
    checked: 'bg rgba(97, 113, 159, 0.08) with a 1px solid #000000 border (capture 225, aria-checked true)'
    states: checked and unchecked read from rest values; no pointer frame
    use: A row of role=radio chips on home (50-84 x 36) at home::[data-omd-capture="226"]
  switch:
    type: toggle
    backgroundColor: '#000000'
    textColor: '#f7f8fb'
    rounded: 16px
    size: 30px x 18px
    states: rest only; the switch was not operated
    use: Switch input inside a label in the /market/cars filter bar at surface-2::[data-omd-capture="11"]
  outline-small-button:
    type: button
    backgroundColor: transparent
    textColor: '#0c0d11'
    border: 1px solid rgba(97, 113, 159, 0.16)
    rounded: 4px
    padding: 0px 12px
    height: 40px
    typography: 13px / 400 / 18px spoqaHanSansNeo, tracking 0.078px
    states: rest only
    use: Small outlined actions such as 판매과정 더 자세히 on /sell (148 x 40); home capture 290 (89 x 40)
  chat-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0c0d11'
    rounded: 100px
    padding: 8px 16px 8px 8px
    height: 56px
    shadow: rgba(0, 0, 0, 0.12) 0px 2px 8px 0px
    states: rest only
    use: 채팅 문의 floating button on /market/cars (127 x 56) at surface-2::[data-omd-capture="105"]
  warranty-banner:
    type: card
    backgroundColor: '#101115'
    rounded: 4px
    size: 248px x 100px
    use: 모든 차 1년 무료 보증 banner at the top of /market/cars at surface-2::[data-omd-capture="10"]; its text sits in children that were not captured, so no text colour is claimed
  step-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    size: 200px x 280px
    shadow: rgba(0, 0, 0, 0.08) 0px 16px 20px 0px, rgba(0, 0, 0, 0.04) 0px 8px 16px 0px, rgba(0, 0, 0, 0.04) 0px 0px 8px 0px
    highlighted: 'bg #396eff with #ffffff text and 24px padding on one card of the row'
    use: Sale-process cards on /sell (집 앞, 방문 평가 / 48시간 경매 / 최고가에 판매결정) at surface-3::li
  review-card:
    type: card
    backgroundColor: '#ffffff'
    border: 1px solid rgba(97, 113, 159, 0.16)
    rounded: 4px
    padding: 16px
    size: 304px x 256px
    shadow: rgba(0, 0, 0, 0.03) 0px 4px 2px 0px
    use: 판매후기 cards on /sell (G70, 더 뉴 스포티지 R, QM6 and others) at surface-3::li
  dropdown-menu:
    type: card
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 8px 0px 8px 8px
    shadow: rgba(0, 0, 0, 0.08) 0px 16px 20px 0px, rgba(0, 0, 0, 0.04) 0px 8px 16px 0px, rgba(0, 0, 0, 0.04) 0px 0px 8px 0px
    use: Brand menu opened from 브랜드 전체 on home (240 x 429) at home::[data-omd-interaction-capture="menu-0-0"]; 30 items of 224 x 38 with 8px 12px padding and a 4px radius
  faq-row:
    type: button
    backgroundColor: transparent
    textColor: '#0c0d11'
    padding: 12px 0px
    height: 48px
    typography: 18.72px / 700 spoqaHanSansNeo — the browser's default h3 size, since the question sits in an unstyled h3
    states: rest only; no answer was opened
    use: 자주 묻는 질문 on /sell (944 x 48) at surface-3::[data-omd-capture="12"]
fonts:
  roles:
    body: spoqaHanSansNeo
---

# Heydealer

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Heydealer; reproduced for educational reference. Full prose: https://oh-my-design.kr/heydealer/design.md
