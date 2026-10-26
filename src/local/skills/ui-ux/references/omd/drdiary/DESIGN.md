---
name: Dr.diary
colors:
  primary: '#3eaeff'
  primary-tint: '#ecf7ff'
  ink: '#232f4d'
  ink-pure: '#000000'
  slate: '#4f5971'
  slate-soft: '#656d82'
  gray: '#7b8294'
  muted: '#9197a6'
  faint: '#bdc1ca'
  violet: '#4970f5'
  violet-tint: '#d7dffd'
  surface: '#f5f8fb'
  hairline: '#dee0e4'
  white: '#ffffff'
typography:
  display:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.38
    letterSpacing: '-0.2px'
    use: 'Page headlines on /solution and /news/press (white over imagery) and /contact (in #232f4d), 88px line'
  hero:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.38
    letterSpacing: '-0.2px'
    use: Home hero line (당신의 … 일상이 지속될 수 있도록), white over the hero image, 88px line
  section:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.2px'
    use: 'Section headings (닥터다이어리가 지향하는 가치, 걸어온 길), 56px line, in #232f4d or #000000'
  list:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.58
    letterSpacing: '-0.2px'
    use: 'Timeline items under 걸어온 길 on home, 38px line, in #4f5971'
  button:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.58
    letterSpacing: '-0.2px'
    use: Pill action labels (문의하기, 자세히 보기, 상담 신청하기), 38px line
  chip:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.58
    letterSpacing: '-0.2px'
    use: Press filter chips (언론, 미디어), 38px line
  nav:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.2px'
    use: Header navigation (Platform, Solution, Brand, News, Contact), 32px line; the current page's item is 700
  tab:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: '-0.2px'
    use: Underline tabs on /solution (커넥트, 클래스), 32px line
  card-title:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.56
    letterSpacing: '-0.1px'
    use: 'Press card titles, 28px line, in #232f4d; the same metrics set the store button labels'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default, 24px line, in #000000'
  caption:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.56
    letterSpacing: '-0.1px'
    use: 'Footer address and captions, 25px line, in #9197a6'
rounded:
  pager-sm: 4px
  pager: 6px
  store: 8px
  card: 16px
  card-lg: 20px
  pill: 9999px
spacing:
  cta-y: 16
  cta-x: 32
  chip-y: 12
  chip-x: 24
  nav-y: 12
  nav-x: 8
  card-pad: 32
components:
  inquiry-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3eaeff'
    border: '1px solid #3eaeff'
    rounded: 9999px
    padding: 16px 32px
    height: 72px
    typography: 24px / 600 / 38px Pretendard, letter-spacing -0.2px
    hover: opacity 0.8
    pressed: opacity 0.8
    states: 'probe on /contact: hover and pressed settle at opacity 0.8 (transition all 0s); focus (Tab #7) shows no change; the bundle''s hover and pressed frames record no fill, text or border change'
    use: '문의하기 on the five inquiry cards of /contact (captures 6-10), 204 x 72, each on a #f5f8fb card with a #dee0e4 hairline; the label is a p and a blue arrow image'
    focus: no visible change (measured 2026-10-16) on :focus-visible
  more-button:
    type: button
    backgroundColor: transparent
    textColor: '#3eaeff'
    border: '1px solid #3eaeff'
    rounded: 9999px
    padding: 12px 32px
    height: 64px
    typography: 24px / 600 / 38px Pretendard
    hover: 'bg #ecf7ff'
    pressed: 'bg #ecf7ff'
    states: 'probe: hover and pressed settle on #ecf7ff after a 0.15s colour transition; focus (Tab #14) shows no change'
    use: 자세히 보기 → under the connect tab of /solution at surface-2::[data-omd-capture="13"], 204 x 64
  consult-button:
    type: button
    backgroundColor: '#232f4d'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 16px 24px 16px 36px
    height: 70px
    typography: 24px / 600 / 38px Pretendard
    states: 'probe: hover and pressed show no change; focus (Tab #15) swaps only the arrow image source, with no colour, border or outline change'
    use: 상담 신청하기 near the foot of /solution, 270 x 70, the only filled action captured
  filter-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#656d82'
    border: '1px solid #dee0e4'
    rounded: 9999px
    padding: 12px 24px
    height: 64px
    typography: 24px / 500 / 38px Pretendard
    selected: 'bg #232f4d, fg #ffffff'
    states: 'probe: neither the selected nor the unselected chip changes on hover, pressed or focus'
    use: Press filter chips on /news/press (언론 selected, 미디어), 91-112 x 64
  underline-tab:
    type: tab
    textColor: '#bdc1ca'
    padding: 0px 38px 6px
    height: 38px
    typography: 20px / 600 / 32px Pretendard
    selected: 'fg #232f4d with a 2px bottom border in #232f4d'
    hover: 'fg #4f5971'
    pressed: 'fg #4f5971'
    states: 'probe: the unselected tab settles on #4f5971 on hover and pressed after a 0.15s colour transition; focus (Tab #13) shows no change'
    use: 커넥트 and 클래스 tabs on /solution, 127 x 38
  feature-card-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#7b8294'
    border: '1px solid #dee0e4'
    rounded: 20px
    padding: 12px 32px
    height: 84px
    typography: 24px / 600 / 38px Pretendard
    selected: 'expands to 347 x 254 with padding 32px and label #232f4d; its own border is transparent in the capture'
    hover: 'border #4f5971'
    pressed: 'border #4f5971'
    states: 'probe: hover and pressed settle on a #4f5971 border after a 0.2s transition; focus (Tab #8) swaps only an icon image'
    use: Feature selector cards on /solution (휴먼 코칭, 전문 콘텐츠, 기록 관리 SW, 통계 리포트), 347 x 84
  press-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #dee0e4'
    rounded: 16px
    size: 320px x 373px
    states: bundle hover and pressed frames on the /news/press cards show no fill, text or border change
    use: Press cards in the home news carousel (10 instances, 16px radius); the /news/press grid uses the same card at 376 x 372 with a 20px radius
  pagination-button:
    type: button
    textColor: '#656d82'
    rounded: 6px
    size: 40px x 40px
    typography: 20px / 600 / 32px Pretendard
    selected: 'bg #d7dffd, fg #4970f5'
    disabled: 'fg #bdc1ca with a 4px radius on the first and previous page arrows'
    states: 'probe on page 2: hover, pressed and focus (Tab #19) show no change'
    use: Pagination under the press grid on /news/press
  store-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 8px
    padding: 12px 16px
    height: 54px
    typography: 18px / 500 / 28px Pretendard, letter-spacing -0.1px
    states: bundle hover and pressed frames record no change
    use: Google Play and App Store links in the closing app band of every page, 158 x 54 and 143 x 54
  nav-item:
    type: tab
    textColor: '#4f5971'
    padding: 12px 8px
    height: 48px
    typography: 20px / 400 / 32px Pretendard
    selected: the current page's item turns 700; its label is gradient-clipped text, so no colour is declared
    states: selected variant from rest values on /solution, /news/press and /contact; no pointer frame
    use: Header navigation on all four pages (Platform, Solution, Brand, News, Contact)
fonts:
  roles:
    sans: Pretendard
---

# Dr.diary

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Dr.diary; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/drdiary/DESIGN.md
