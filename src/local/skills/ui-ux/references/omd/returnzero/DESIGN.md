---
name: Return Zero
colors:
  primary: '#222222'
  on-primary: '#ffffff'
  ink: '#222222'
  text: '#000000'
  white: '#ffffff'
  hairline: '#eeeeee'
  hairline-hover: '#cccccc'
  slate: '#555555'
  muted: '#999999'
  accent: '#3a89ff'
  accent-hover: '#3174d9'
typography:
  display:
    fontSize: 42px
    fontWeight: 300
    lineHeight: 1.29
    use: 'Home hero headline, Pretendard Light, 54px line, in #222222'
  dev-hero:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-1.5px'
    use: developers.rtzr.ai hero headline, 48px line, letter-spacing -1.5px, in white over the hero image
  plan-title:
    fontSize: 32px
    fontWeight: 700
    use: White headings in the /pricing plan-card row; normal line height
  plan-lead:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.6
    use: Subline in the /pricing hero, 32px line, in white
  button-lg:
    fontSize: 18px
    fontWeight: 600
    use: Large action labels (리턴제로 STT 알아보기, 바로 체험, 서비스 도입문의); normal line height
  button:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    use: Compact action labels (문의하기 in the header, 더 알아보기, 읽어보기), 19.6px line
  nav:
    fontSize: 16px
    fontWeight: 500
    use: 'Header navigation (COMPANY, RTZR STT, CALLABO, VITO), in #222222; normal line height'
  menu:
    fontSize: 16px
    fontWeight: 600
    use: 'Header menu links (News, Career, Blog, CI, 공고, Pricing, Developers), in #222222; normal line height'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default, 24px line, in #000000'
  demo-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.17
    use: 'Heading inside the developers.rtzr.ai STT demo, 21px line, in #555555'
  demo-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: '-0.5px'
    use: 'Copy inside the developers.rtzr.ai STT demo, 21.98px line, letter-spacing -0.5px, in #555555'
  pill:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.17
    use: 회원가입 / 로그인 account pills on developers.rtzr.ai, 14px line
rounded:
  action: 4px
  nav-pill: 20px
  pill: 30px
  record: 60px
spacing:
  button-pad: 10
  cta-y: 24
  cta-x: 40
  dev-cta-y: 22
  record-y: 20
  pill-y: 9
  pill-x: 24
components:
  header-cta:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    rounded: 4px
    padding: 10px
    height: 42px
    typography: 14px / 600 / 19.6px Pretendard
    states: 'probe on home: hover, pressed and focus (Tab #6) show no change; transition all 0s'
    use: 문의하기 in the header of every rtzr.ai page at home::[data-omd-capture="5"], 98 x 42
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  primary-cta:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    rounded: 4px
    padding: 24px 40px
    height: 69px
    typography: 18px / 600 Pretendard
    states: 'probe on home, /stt and /pricing: hover, pressed and focus show no change; transition all 0s'
    use: 'Large filled actions: 리턴제로 STT 알아보기 in the home hero at home::[data-omd-capture="17"] (247 x 69), 서비스 도입문의 on /stt and 맞춤 요금제 문의 on /pricing'
  card-button:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    rounded: 4px
    padding: 10px
    height: 42px
    typography: 14px / 600 / 21px Pretendard
    states: 'probe on home: the button itself does not change on hover, pressed or focus; hover and pressed darken its card''s border from #eeeeee to #cccccc'
    use: 더 알아보기 (product cards) and 읽어보기 (customer-story cards linking to blog.rtzr.ai) inside white cards on home, 98 x 42
  feature-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #eeeeee'
    use: 'White product and customer-story cards in the home carousels that hold 더 알아보기 and 읽어보기; the border turns #cccccc while the pointer is over the card''s button'
  secondary-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 4px
    padding: 24px 40px
    height: 69px
    typography: 18px / 600 Pretendard
    states: 'probe: hover, pressed and focus show no change on 바로 체험 and 상담신청; on the pricing plan buttons hover and pressed are unmeasured and focus shows no change'
    use: 'White actions on dark grounds: 바로 체험 in the /stt hero at surface-2::[data-omd-capture="17"] (146.5 x 69), 상담신청 on a #222222 band and 바로 무료 체험 / 클라우드 도입 문의 at the foot of the /pricing plan cards'
  outline-cta:
    type: button
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 4px
    padding: 24px 40px
    height: 71px
    typography: 18px / 600 Pretendard
    states: 'probe on /stt: hover, pressed and focus show no change; transition opacity 0.5s ease'
    use: 요금제 보기 and 정확도 비교 beside 바로 체험 in the /stt hero, transparent over the hero image, 164 x 71
  record-button:
    type: button
    backgroundColor: '#3a89ff'
    textColor: '#ffffff'
    rounded: 60px
    padding: 20px 40px
    height: 58px
    typography: 18px / 400 Pretendard; label 16px / 700
    hover: 'bg #3174d9'
    pressed: 'bg #3174d9'
    states: 'probe: hover and pressed settle on #3174d9 (transition all 0s; the bundle''s state frames agree); focus (Tab #10) shows no change'
    use: 녹음시작 in the developers.rtzr.ai STT demo at surface-4::[data-omd-capture="9"], 167 x 58; developer portal only
  demo-tab:
    type: tab
    textColor: '#999999'
    typography: 16px / 500 Pretendard
    selected: 'fg #3a89ff, weight 700, 2px bottom border #3a89ff (실시간 녹음 at surface-4::#realtime)'
    states: 'probe on 파일 업로드: hover, pressed and focus (Tab #8) show no change'
    use: 실시간 녹음 / 파일 업로드 / 샘플파일 demo mode tabs on developers.rtzr.ai at surface-4::[data-omd-capture="7"]; developer portal only
  account-pill:
    type: button
    textColor: '#ffffff'
    border: '1px solid #eeeeee'
    rounded: 30px
    padding: 9px 24px
    height: 34px
    typography: 12px / 500 / 14px Pretendard
    hover: 'bg rgba(0, 0, 0, 0.05), fg #222222, border 1px solid #222222 (read with the header in its scrolled state, where the pill rests at #555555)'
    pressed: 'bg rgba(0, 0, 0, 0.05), fg #222222, border 1px solid #222222'
    states: 'probe: hover and pressed as above; focus (Tab #3) shows no change'
    use: 회원가입 and 로그인 in the developers.rtzr.ai header, white over the dark hero at rest, 91.5 x 34; developer portal only
  dev-outline-cta:
    type: button
    textColor: '#ffffff'
    border: 1px solid rgba(255, 255, 255, 0.5)
    rounded: 4px
    padding: 22px 40px
    height: 67px
    typography: 18px / 600 Pretendard
    states: 'probe: hover, pressed and focus show no change on 사용문의 and on its white partner 무료로 체험하기 (#ffffff fill, #222222 label, 193 x 67)'
    use: 사용문의 in the developers.rtzr.ai hero at surface-4::[data-omd-capture="4"], 144 x 67; developer portal only
fonts:
  roles:
    sans: Pretendard
---

# Return Zero

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Return Zero; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/returnzero/DESIGN.md
