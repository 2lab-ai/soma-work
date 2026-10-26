---
name: Stibee
colors:
  primary: '#ff6464'
  primary-hover: '#ff5252'
  on-primary: '#ffffff'
  ink: '#202124'
  muted: '#606165'
  caption: '#747579'
  subtle: '#9d9ea2'
  border: '#bcbdc1'
  border-focus: '#414245'
  surface: '#f6f6f6'
  hairline: '#ebebeb'
  white: '#ffffff'
typography:
  display-hero:
    fontSize: 44px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.4px'
    use: 'Home hero headline (고객이 좋아하는 이메일 스티비로 보내세요), 61.6px line, in #202124'
  page-title:
    fontSize: 42px
    fontWeight: 600
    lineHeight: 1.4
    use: 'Page headlines on /pricing (성장 단계에 따라 요금제를 선택하세요) and /feature/email, 58.8px line, in #202124'
  feature-title:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: 'Feature headings on /feature/email, 48px line, in #202124'
  plan-price:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.5
    use: Plan prices on the /pricing cards, 42px line
  lead:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: 'Hero sub-copy on home and the page description on /feature/email, set as h2, 25.6px line, in #606165'
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 2.63
    use: Header navigation labels (기능, 가격, 자료, 도움말, 로그인), 42px line that fills the 42px item
  link:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.88
    use: Coral text link on /feature/email, 30px line
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default text, 21px line, in #202124'
  button:
    fontSize: 14px
    fontWeight: 400
    use: Header and plan-card 무료로 시작하기 labels; the line height equals the button height (42px header, 36px plan card)
  label:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
    use: 'Small feature labels above the /feature/email headings, 19.2px line, in #747579'
rounded:
  none: 0px
  control: 4px
spacing:
  cta-x: 20
  cta-lg-x: 26
  outline-y: 12
  outline-x: 20
  field-y: 11
  field-x: 12
  field-trail: 34
components:
  button-primary:
    type: button
    backgroundColor: '#ff6464'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 20px
    height: 42px
    typography: 14px / 400 / 42px Pretendard Variable
    hover: 'bg #ff5252'
    pressed: 'bg #ff5252'
    states: 'hover and pressed settle on #ff5252 after an all 0.3s ease transition; focus (Tab #7) shows no change'
    use: 무료로 시작하기 in the header of all three captured pages at home::[data-omd-capture="6"], 128 x 42
    focus: no visible change (measured 2026-10-16) on :focus-visible
  button-primary-lg:
    type: button
    backgroundColor: '#ff6464'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 26px
    height: 52px
    typography: 16px / 400 / 50px Pretendard Variable
    hover: 'bg #ff5252'
    pressed: 'bg #ff5252'
    states: 'hover and pressed settle on #ff5252 after an all 0.6s ease transition; focus (Tab #8) shows no change'
    use: Hero 무료로 시작하기 on home at home::[data-omd-capture="7"], 153 x 52
  button-plan:
    type: button
    backgroundColor: '#ff6464'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 20px
    height: 38px
    typography: 14px / 400 / 36px Pretendard Variable
    hover: 'bg #ff5252'
    pressed: 'bg #ff5252'
    states: 'hover and pressed settle on #ff5252 after an all 0.6s ease transition; focus (Tab #11) shows no change'
    use: 무료로 시작하기 on each of the four plan cards on /pricing at surface-2::[data-omd-capture="8"], 228 x 38
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#ff6464'
    border: '1px solid #ff6464'
    rounded: 4px
    padding: 12px 20px
    height: 52px
    typography: 16px / 400 Pretendard Variable
    states: 'hover, pressed and focus (Tab #15) show no change; it computes transition all 0s'
    use: '영업팀에 문의하기 in the enterprise box on /pricing (232 x 52), a box outlined in #ebebeb; read by the fixed probe, below the collector''s first viewport'
  text-link:
    type: button
    textColor: '#ff6464'
    rounded: 4px
    height: 38px
    typography: 16px / 400 / 30px Pretendard Variable
    states: the bundle's hover and pressed frames record the same values as rest; no probe reading
    use: Coral text link on /feature/email at surface-3::[data-omd-capture="7"], 119 x 38, with a transparent background
  nav-link:
    type: tab
    textColor: '#202124'
    rounded: 4px
    padding: 0px 20px
    height: 42px
    typography: 16px / 400 / 42px Pretendard Variable
    hover: 'fg #9d9ea2, bg #ffffff'
    pressed: 'bg #ffffff'
    focus: 'bg #ffffff'
    states: 'all 0.3s ease transition; the label greys to #9d9ea2 only on hover'
    use: Header links (가격, 도움말, 로그인) on all three pages at home::[data-omd-capture="2"], 68 x 42 for 가격
  nav-menu:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#202124'
    rounded: 4px
    padding: 0px 20px
    height: 42px
    typography: 16px / 400 / 42px Pretendard Variable
    hover: 'fg #9d9ea2'
    pressed: 'fg #9d9ea2'
    states: 'all 0.3s ease transition; focus (Tab #2) shows no change'
    use: Dropdown triggers in the header (기능, 자료) at home::[data-omd-capture="1"], 68 x 42
  tier-select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#202124'
    border: '1px solid #bcbdc1'
    rounded: 4px
    padding: 11px 34px 11px 12px
    height: 48px
    typography: 14px / 400 Pretendard Variable
    focus: 'border 1px solid #414245'
    states: 'hover shows no change; pressed was not measured (:active did not match); focus (Tab #8) switches the border to #414245 with no transition'
    use: 'Subscriber-count selector on /pricing (~500명, ~1,000명, ~2,500명 …) at surface-2::[data-omd-capture="7"], 180 x 48, on a #f6f6f6 band'
fonts:
  roles:
    sans: Pretendard Variable
---

# Stibee

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Stibee; reproduced for educational reference. Full prose: https://oh-my-design.kr/stibee/design.md
