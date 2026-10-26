---
name: 8percent
colors:
  primary: '#6e49da'
  on-primary: '#ffffff'
  primary-tint: '#ecebfc'
  blue: '#377dfa'
  blue-tint: '#f1f6fe'
  link-blue: '#3282f0'
  link-violet: '#6741d9'
  ink: '#18181b'
  canvas: '#f4f4f5'
  surface: '#ffffff'
  muted: '#8e8e95'
  faint: '#aaaab1'
  disabled: '#e4e4e7'
  footer-strong: '#5a5a60'
  stat: '#3c3c3c'
  legacy-ink: '#1d2024'
  legacy-label: '#4b525a'
  legacy-canvas: '#f1f3f5'
  legacy-faint: '#9ca5ad'
  tab-hover: '#8e8e8e'
  select-border: '#dee2e5'
typography:
  stat:
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: '-0.9px'
    use: '누적 대출액 figure on home, 44px line, in #3c3c3c'
  section:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.6px'
    use: 'Product-list headings (모집중 상품, 오픈 예정 상품) on home and the deals page, 36px line, in #18181b'
  nav:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: '-0.32px'
    use: Header menu triggers (투자, 대출), 24.8px line
  card-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: '-0.32px'
    use: 'Deal-card property name, 24.8px line, in #18181b'
  tab-active:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.75
    letterSpacing: '-0.3px'
    use: 'Selected disclosure tab (경영현황), 28px line, in #1d2024'
  tab:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.4px'
    use: 'Unselected disclosure tabs (이용정보, 취급현황), 24px line, in #9ca5ad'
  button:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: '-0.28px'
    use: Button labels (로그인, 투자하기), 21.7px line
  rate:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: '-0.28px'
    use: 'Interest rate on deal cards, 21.7px line, in #377dfa'
  link:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.71
    letterSpacing: '-0.6px'
    use: 'Text links under home sections (사업공시 보러가기 in #3282f0, 언론기사 link in #6741d9), 24px line'
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.15
    use: 'Document default on all three pages, 16.1px line, in #18181b'
  footer:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: '-0.28px'
    use: 'Footer contact values, 21.7px line, in #8e8e95'
  meta:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.12px'
    use: 'Deal-card meta line (주거안정 7103호), 19.2px line, in #aaaab1'
  badge:
    fontSize: 10px
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: '-0.1px'
    use: Header badge and deal-card chips, 16px line
rounded:
  select: 3px
  control: 8px
  card: 12px
  notice: 16px
  pill: 9999px
spacing:
  control-x: 12
  card: 16
  card-frame: 4
  notice-x: 16
  chip-x: 8
components:
  login-button:
    type: button
    backgroundColor: '#6e49da'
    textColor: '#ffffff'
    rounded: 8px
    padding: 1px 12px
    height: 40px
    typography: 14px / 700 / 21.7px Pretendard, letter-spacing -0.28px
    hover: white overlay rgba(255, 255, 255, 0.08) laid over the fill as a background-image
    pressed: white overlay rgba(255, 255, 255, 0.16)
    focus: '2px solid #6e49da outline at 2px offset'
    states: 'probe on home and /disclosures/management/: hover and pressed add a white overlay layer (the fill itself stays #6e49da), focus draws the violet ring; transition all 0s'
    use: 로그인 at the right end of the header on all three pages, 59.5 x 40; the one filled action a logged-out visitor sees on every page
  gnb-menu:
    type: tab
    textColor: '#18181b'
    typography: 16px / 700 / 24.8px Pretendard, letter-spacing -0.32px
    selected: 'fg #6e49da on the current section (투자 on home and the deals page)'
    hover: the caret beside the label turns 180 degrees
    pressed: the caret turns 180 degrees
    focus: '2px solid #6e49da outline at 2px offset'
    states: 'probe on 투자: hover and pressed flip the caret over a 150ms transition, the label colour does not change; focus draws the violet ring'
    use: Header menu triggers 투자 and 대출 (45 x 25); 법인투자, 상담, 회사소개, 이용안내 and 혜택 follow in lighter 14px items
  invest-button:
    type: button
    backgroundColor: '#ecebfc'
    textColor: '#6e49da'
    rounded: 8px
    padding: 1px 12px
    height: 40px
    typography: 14px / 700 / 21.7px Pretendard, letter-spacing -0.28px
    hover: black overlay rgba(0, 0, 0, 0.04)
    pressed: black overlay rgba(0, 0, 0, 0.08)
    focus: '2px solid #6e49da outline at 2px offset'
    disabled: 'bg #e4e4e7, fg #aaaab1 on cards not yet open (내일 오전 10시 오픈)'
    states: 'probe: hover and pressed add a black overlay layer, focus draws the violet ring; disabled read from the attribute at capture'
    use: 투자하기 at the foot of each open deal card on home and the deals page, 261 x 40
  cart-button:
    type: button
    backgroundColor: '#f4f4f5'
    rounded: 8px
    size: 40px x 40px
    hover: black overlay rgba(0, 0, 0, 0.04)
    pressed: black overlay rgba(0, 0, 0, 0.08)
    focus: '2px solid #6e49da outline at -2px offset (inset)'
    states: 'probe: same overlay steps as 투자하기; the focus ring sits inside the square'
    use: 장바구니 icon button beside 투자하기 on each deal card
  invest-all-button:
    type: button
    backgroundColor: '#f1f6fe'
    textColor: '#18181b'
    rounded: 8px
    padding: 6px 16px 6px 12px
    height: 40px
    typography: 14px / 400 / 16.1px Pretendard
    hover: opacity 0.8
    pressed: opacity 0.6
    focus: '2px solid #6e49da outline at 2px offset'
    states: 'probe: opacity steps over a 0.2s ease transition, read after it settled; focus draws the violet ring'
    use: 전체 상품, 한 번에 투자해볼까요? above the product list on home and the deals page, 234 x 40, with a small image before the label
  notice-link:
    type: button
    backgroundColor: '#f1f3f5'
    textColor: '#4b525a'
    rounded: 16px
    padding: 0px 16px
    height: 56px
    typography: 14px / 400 / 16.1px Pretendard
    focus: '2px solid #6e49da outline at 2px offset'
    states: 'probe: hover and pressed show no change across the link, its two children and three ancestor levels; focus draws the violet ring'
    use: '[공지] announcement row above the product list on home, 1080 x 56'
  disclosure-tab:
    type: tab
    textColor: '#9ca5ad'
    typography: 16px / 400 / 24px Pretendard, letter-spacing -0.4px
    selected: 'fg #1d2024, 16px / 700 / 28px, letter-spacing -0.3px'
    hover: 'fg #8e8e8e'
    pressed: 'fg #8e8e8e'
    focus: '2px solid #6e49da outline at 2px offset'
    states: 'probe on 이용정보: hover and pressed turn the label and its selected bar #8e8e8e; the selected 경영현황 does not change; focus draws the violet ring on both'
    use: Section tabs of 사업공시 (경영현황, 이용정보, 취급현황) on /disclosures/management/
  year-select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#3c3c3c'
    border: '1px solid #dee2e5'
    rounded: 3px
    padding: 0px 28px 0px 10px
    height: 40px
    typography: 14px / 400 / 16.1px Pretendard
    focus: '2px solid #6e49da outline at 2px offset'
    states: 'probe: hover draws nothing (an inset shadow of zero size), pressed unmeasured, focus draws the violet ring'
    use: Year pickers of 임직원 현황 and 전문가 보유내역 on the disclosures page, 74 x 40
  deal-card:
    type: card
    backgroundColor: '#f4f4f5'
    rounded: 12px
    padding: 4px 4px 8px
    size: 349px x 285px
    use: Outer frame of each deal card on home and the deals page; the whole card carries role=button and a white panel sits inside it, with the meta line on the grey frame below
  deal-card-panel:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 16px
    use: White panel inside the deal card holding the property name, rate, 유효담보비율, term, amounts and the two buttons
  gnb-badge:
    type: badge
    backgroundColor: '#377dfa'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 2px 6px
    typography: 10px / 700 / 16px Pretendard, letter-spacing -0.1px
    use: Small blue pill beside a header menu item on all three pages, 29 x 20
  deal-chip:
    type: badge
    backgroundColor: '#f4f4f5'
    textColor: '#18181b'
    rounded: 8px
    padding: 0px 8px
    height: 24px
    typography: 10px / 700 / 16px Pretendard, letter-spacing -0.1px
    use: Chip badge on deal cards (대단지), 42 x 24
fonts:
  roles:
    body: Pretendard
---

# 8percent

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 8percent; reproduced for educational reference. Full prose: https://oh-my-design.kr/8percent/design.md
