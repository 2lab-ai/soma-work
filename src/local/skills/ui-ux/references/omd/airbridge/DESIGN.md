---
name: Airbridge
colors:
  primary: '#155dfc'
  on-primary: '#fafafa'
  link: '#0970ff'
  canvas: '#0a0a0c'
  ink: '#fafafa'
  white: '#ffffff'
  muted: '#98989f'
  surface: '#18181b'
  surface-raised: '#262629'
  ink-light: '#020202'
  body-light: '#171716'
  surface-light: '#efefef'
  input-ink: '#101828'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-1.08px'
    use: Hero headline on every page (광고 성과 측정, AI로 완성하세요 on home), 72px line; its colour computes transparent because the fill is a clipped background gradient
  section:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.72px'
    use: 'Section headings, 63.84px line; #fafafa on the dark canvas, #020202 in the light sections'
  subsection:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.54px'
    use: Explainer headings on the deep-linking page (딥링크란?, 클릭에서 앱 화면까지), 47.88px line
  feature:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.56
    letterSpacing: '-0.39px'
    use: 'Feature tab headings on home (통합 성과측정, 정밀한 분석), 40.44px line; the active item in #fafafa, the others in #98989f'
  case-title:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.33px'
    use: Case-study card titles on home, 33px line
  lead:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Hero subline under the headline, 28px line, in #98989f'
  card-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.27px'
    use: Card and plan titles (더 정확한 어트리뷰션, vs. AppsFlyer), 27px line
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.63
    use: Section intros and testimonial quotes, 29.25px line
  faq:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.56
    letterSpacing: '-0.18px'
    use: FAQ question rows, 28px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    use: 'Card and feature descriptions, 26px line, #98989f on dark and #171716 on light'
  cta:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.5
    use: 48px call-to-action labels (데모 신청하기, 요금 확인하기), 22.5px line
  nav:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Header menu buttons, the header CTA, inline links and plan toggles, 20px line
  eyebrow:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.43
    use: 'Section eyebrow (글로벌 스탠다드에 부합하는 MMP), 20px line, in #98989f'
  overline:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0.6px
    use: 'Feature-group labels on the pricing page, 16px line, in #98989f'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: 'Footer company and copyright lines, 16px line, in #98989f'
rounded:
  cta: 8px
  nav: 10px
  segment: 12px
  panel: 14px
  card: 18px
  band: 26px
spacing:
  cta-x: 16
  cta-wide-x: 28
  nav-y: 8
  nav-x: 12
  card-pad: 20
  faq-y: 24
  band-y: 96
  band-x: 32
components:
  primary-cta:
    type: button
    backgroundColor: '#155dfc'
    textColor: '#fafafa'
    rounded: 8px
    padding: 0px 16px
    height: 48px
    typography: 15px / 500 / 22.5px Pretendard Variable
    shadow: 0 0 0 1px rgba(21, 93, 252, 0.15), 0 2px 4px rgba(21, 93, 252, 0.1), 0 8px 24px rgba(21, 93, 252, 0.1)
    hover: 'bg #155dfc at 90% opacity'
    pressed: 'bg #155dfc at 90% opacity and the button scales to about 98% (138.5 x 48 -> 135.7 x 47)'
    states: 'probe on home: hover and pressed settle at 90% fill opacity after a 0.15s transition; focus (Tab #20) shows no change within the compared scope'
    use: 데모 신청하기 hero call-to-action on all three pages at home::[data-omd-capture="11"], 138 x 48; the closing band repeats it at 158 x 48 with 8px 28px padding
  header-cta:
    type: button
    backgroundColor: '#155dfc'
    textColor: '#fafafa'
    rounded: 8px
    padding: 0px 12px
    height: 32px
    typography: 14px / 500 / 20px Pretendard Variable
    hover: 'bg #155dfc at 90% opacity'
    pressed: 'bg #155dfc at 90% opacity and the button scales to about 98%'
    focus: '3px ring of #155dfc at 50% opacity (box-shadow 0 0 0 3px)'
    states: 'probe on home: hover and pressed settle at 90% fill opacity; real-Tab focus (Tab #18) adds the 3px ring'
    use: 데모 신청하기 in the fixed header of every page at home::[data-omd-capture="9"], 100 x 32
  plan-cta:
    type: button
    backgroundColor: '#155dfc'
    textColor: '#fafafa'
    rounded: 8px
    padding: 8px 16px
    height: 36px
    typography: 14px / 500 / 20px Pretendard Variable
    states: 'rest only: the pricing page''s pseudo-state pass hit the collector''s 90s step budget and the probe did not reach this link, so its states are unmeasured, not absent'
    use: 데모 신청하기 inside the two pricing-model cards on /ko/pricing at surface-2::[data-omd-capture="16"], full card width 386 x 36
  ghost-cta:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.036)
    textColor: '#fafafa'
    border: 1px solid rgba(255, 255, 255, 0.12)
    rounded: 8px
    padding: 0px 28px
    height: 48px
    typography: 15px / 500 / 22.5px Pretendard Variable
    hover: bg rgba(255, 255, 255, 0.06)
    pressed: bg rgba(255, 255, 255, 0.06) and the button scales to about 98%
    focus: '3px ring of #155dfc at 50% opacity (box-shadow 0 0 0 3px)'
    states: 'probe on home and /ko/pricing: hover and pressed settle on the 6% white wash; real-Tab focus adds the 3px ring'
    use: 요금 확인하기 beside the hero call-to-action at home::[data-omd-capture="12"] (139 x 48); 영업팀 문의하기 on /ko/pricing; a 40px version reads 더 많은 성공 사례 보기
  light-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#020202'
    border: '1px solid #020202'
    rounded: 8px
    padding: 0px 16px
    height: 40px
    typography: 14px / 500 / 20px Pretendard Variable
    states: rest only; the collector recorded no state frame for it and it was not probed
    use: 자세히 보기 button in the light comparison section of home at home::[data-omd-capture="27"], 130 x 40
  text-link:
    type: button
    textColor: '#0970ff'
    padding: 16px 0px 0px
    typography: 14px / 500 / 20px Pretendard Variable
    hover: 'label and arrow #0970ff at 80% opacity'
    pressed: 'label and arrow #0970ff at 80% opacity'
    states: 'probe on home: hover and pressed settle at 80% after a 0.15s colour transition; focus (Tab #30) draws only the browser''s auto-style outline, so no brand focus style is declared'
    use: 자세히 보기 links at the foot of the light-section cards on home at home::[data-omd-capture="21"]
  nav-item:
    type: tab
    textColor: '#ffffff'
    rounded: 10px
    padding: 8px 12px
    height: 36px
    typography: 14px / 500 / 20px Pretendard Variable
    hover: bg rgba(0, 0, 0, 0.06)
    pressed: bg rgba(0, 0, 0, 0.06)
    states: 'probe on home: hover and pressed settle on a 6% black wash after a 0.3s transition; focus (Tab #10) draws the browser''s auto-style outline tinted #155dfc at 50%, not an authored ring'
    use: 기능 소개, 솔루션 and 인사이트 menu buttons in the fixed header at home::[data-omd-capture="1"]
  plan-toggle:
    type: tab
    backgroundColor: transparent
    textColor: '#98989f'
    border: 1px solid transparent
    rounded: 10px
    padding: 4px 24px
    height: 29px
    typography: 14px / 500 / 20px Pretendard Variable
    selected: 'bg rgba(255, 255, 255, 0.036), fg #fafafa, border 1px solid rgba(255, 255, 255, 0.12), shadow 0 1px 3px rgba(0, 0, 0, 0.1)'
    hover: 'the unselected toggle takes the selected look: fg #fafafa, bg rgba(255, 255, 255, 0.036), border rgba(255, 255, 255, 0.12)'
    pressed: same as hover
    focus: '1px solid #155dfc outline plus a 3px ring of #155dfc at 50% opacity'
    states: 'probe on /ko/pricing: the selected toggle shows no hover or pressed change; focus on the selected toggle (Tab #21) draws the outline and ring; the unselected toggle was not reached by Tab, so its focus is unmeasured'
    use: 'MMP 플랜 / 딥링크 플랜 switch on /ko/pricing, inside a #262629 track with 12px radius and 3px padding; unselected at surface-2::[data-omd-capture="14"]'
  faq-item:
    type: button
    textColor: '#fafafa'
    rounded: 10px
    padding: 24px 0px
    height: 76px
    typography: 18px / 500 / 28px Pretendard Variable, letter-spacing -0.18px
    hover: 'question turns #155dfc and the row behind it tints #155dfc at 2% opacity'
    pressed: same as hover
    focus: '3px ring of #155dfc at 50% opacity (box-shadow 0 0 0 3px)'
    states: 'probe on /ko/pricing: hover and pressed settle after a 0.3s colour transition; real-Tab focus (Tab #25) adds the 3px ring'
    use: FAQ rows on home and /ko/pricing (MAU(월간 활성 유저)란 무엇인가요?), 702 x 76
  email-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#101828'
    border: '1px solid #ffffff'
    rounded: 10px 0px 0px 10px
    padding: 0px 12px
    height: 36px
    typography: 14px / 400 / 20px Pretendard Variable
    states: the collector's form-error pass on home and /ko/product/deep-linking recorded the same values as rest, so no error style is declared; focus is not declared from bundles
    use: 회사 이메일 주소를 입력하세요. newsletter field in the footer of every page at home::[data-omd-capture="52"], 304 x 36, joined to 구독하기
  subscribe-button:
    type: button
    backgroundColor: '#155dfc'
    textColor: '#fafafa'
    rounded: 0px 10px 10px 0px
    padding: 0px 16px
    height: 36px
    typography: 14px / 500 / 20px Pretendard Variable
    hover: 'bg #155dfc at 90% opacity'
    pressed: 'bg #155dfc at 90% opacity and the button scales to about 98%'
    states: 'probe on home: hover and pressed settle at 90% after a 0.15s transition; focus (Tab #61) draws the browser''s auto-style outline tinted #155dfc at 50%, not an authored ring'
    use: 구독하기, joined to the right edge of the footer email field at home::[data-omd-capture="53"], 80 x 36
  suggestion-chip:
    type: button
    backgroundColor: rgba(21, 93, 252, 0.05)
    textColor: '#155dfc'
    border: 1px solid rgba(21, 93, 252, 0.2)
    rounded: 9999px (rounded-full, computes 3.35544e+07px)
    padding: 6px 12px
    height: 30px
    typography: 12px / 500 / 16px Pretendard Variable
    states: rest only; no state frame was recorded and the chips were not probed
    use: Prompt chips in the Airbridge AI panel (어떤 플랜이 맞을까요?, Airbridge 주요 기능이 뭐예요?) at home::[data-omd-capture="98"]
  chat-launcher:
    type: button
    backgroundColor: '#155dfc'
    textColor: '#fafafa'
    rounded: 9999px (rounded-full, computes 3.35544e+07px)
    size: 56px x 56px
    shadow: '0 0 0 2px #0a0a0c, 0 0 0 4px rgba(21, 93, 252, 0.2), 0 10px 15px -3px rgba(21, 93, 252, 0.25), 0 4px 6px -4px rgba(21, 93, 252, 0.25)'
    states: rest only; no state frame was recorded and it was not probed
    use: 채팅 열기, fixed at the bottom right of every page at home::[data-omd-capture="104"]
  case-card:
    type: card
    backgroundColor: '#18181b'
    textColor: '#fafafa'
    border: 1px solid rgba(255, 255, 255, 0.08)
    rounded: 18px
    size: 392px x 476px
    use: Case-study cards on home (후야호, 삼쩜삼, 퍼스트 디센던트) at home::[data-omd-capture="32"]
  light-card:
    type: card
    backgroundColor: '#efefef'
    textColor: '#020202'
    border: 1px solid rgba(232, 232, 232, 0.4)
    rounded: 18px
    size: 392px x 191px
    use: Feature cards in the light comparison sections of home (더 정확한 어트리뷰션, 디퍼드 딥링킹), each ending in a 자세히 보기 link
  plan-card:
    type: card
    backgroundColor: '#18181b'
    textColor: '#fafafa'
    border: 1px solid rgba(255, 255, 255, 0.08)
    rounded: 14px
    padding: 24px 0px
    size: 436px x 714px
    use: Pricing-model cards on /ko/pricing (월간 활성 유저(MAU) 기반, 어트리뷰티드 인스톨 기반), each with a full-width 데모 신청하기
  closing-band:
    type: card
    backgroundColor: '#18181b'
    rounded: 26px
    padding: 96px 32px
    size: 1216px x 393px
    shadow: inset 0 0 60px oklch(0.65 0.1 236.24 / 0.5)
    use: Closing call-to-action band above the footer on all three pages, with the 158 x 48 데모 신청하기 and its ghost partner
  ai-panel:
    type: dialog
    backgroundColor: rgba(10, 10, 12, 0.98)
    size: 480px x 900px (fixed to the right edge)
    use: 'Airbridge AI side panel (role=dialog, Airbridge에 대해 무엇이든 물어보세요) with its prompt chips, a #18181b message field and a 32px send button'
fonts:
  roles:
    sans: Pretendard Variable
---

# Airbridge

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Airbridge; reproduced for educational reference. Full prose: https://oh-my-design.kr/airbridge/design.md
