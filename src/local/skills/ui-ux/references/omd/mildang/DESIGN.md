---
name: Milddang (I Hate Flying Bugs)
colors:
  primary: '#32d7b4'
  on-primary: '#07111f'
  action: '#20c9a7'
  action-hover: '#3ad7b8'
  submit: '#16bea8'
  panel: '#232952'
  corporate-accent: '#0064ff'
  ink: '#15171c'
  ink-product: '#222222'
  heading-product: '#10212b'
  ink-black: '#000000'
  slate: '#666b76'
  nav-muted: '#aeb9c8'
  footer-muted: '#aeb2bd'
  white: '#ffffff'
  band: '#151520'
  hairline: '#e0e3e8'
  field-border: '#c6d5d8'
  accent-text: '#12a78a'
typography:
  display:
    fontSize: 74px
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: '-3.108px'
    use: 'Corporate hero on ihateflyingbugs.com (질 높은 교육, 모두의 기회로.), 90.28px line, in #ffffff over the hero backdrop'
  display-service:
    fontSize: 51.84px
    fontWeight: 900
    lineHeight: 1.3
    letterSpacing: '-1.296px'
    use: 'Hero of mildang.kr/service/ (좋은 교육의 기회가 환경에 좌우되지 않도록.), 67.392px line, in #ffffff'
  section:
    fontSize: 51.84px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: '-1.296px'
    use: 'Section headings of mildang.kr/service/, 67.392px line, in #10212b on light bands and #ffffff on dark ones'
  page-title:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: '-1.4px'
    use: 'Corporate 밀당PT page title (AI가 설계하고, 사람이 끝까지 함께합니다.), 54px line, in #15171c'
  review-title:
    fontSize: 27px
    fontWeight: 700
    lineHeight: 1.41
    letterSpacing: '-1.08px'
    use: 'Review card headlines on mildang.kr (사교육 하나 갈아탄 후 두 자매 모두 의대 합격!), 38px line, in #000000'
  hero-product:
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: '-0.44px'
    use: 'mildang.kr hero headline (중고등 공부, 뭘 시켜도 성적은 그대로?), 30.8px line, in #ffffff'
  card-title:
    fontSize: 21px
    fontWeight: 700
    letterSpacing: '-0.525px'
    use: 'Card headings on mildang.kr/service/, normal line height, in #10212b'
  hero-lead:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: '-0.18px'
    use: Corporate hero description, 29.7px line, white at 86% opacity
  lead:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.8
    letterSpacing: '-0.4px'
    use: Section leads on mildang.kr/service/, 30.6px line
  lead-corporate:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.85
    use: 'Lead paragraph on the corporate 밀당PT page, 31.45px line, in #666b76'
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.4px'
    use: Card and feature copy on mildang.kr/service/, 24px line
  nav:
    fontSize: 15px
    fontWeight: 700
    use: 'Corporate header navigation (회사소개, 사업소개, 뉴스룸), in #15171c'
  nav-product:
    fontSize: 14px
    fontWeight: 750
    use: 'mildang.kr header navigation (서비스, 커리큘럼, 학습후기, FAQ), in #aeb9c8 over the hero'
  button:
    fontSize: 14px
    fontWeight: 900
    use: Header PT 신청하기 → label
  button-lg:
    fontSize: 18px
    fontWeight: 900
    letterSpacing: '-0.4px'
    use: 무료 상담 신청하기 label on mildang.kr/service/
  eyebrow:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1.7px
    use: Uppercase eyebrows on ihateflyingbugs.com (EDUCATION, FOR EVERYONE.), 18px line
  eyebrow-service:
    fontSize: 12px
    fontWeight: 900
    letterSpacing: 1.8px
    use: 'Uppercase eyebrows on mildang.kr/service/, in #12a78a on light bands'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.9
    use: 'Corporate footer copyright, 22.8px line, in #8e929d'
rounded:
  link: 3px
  select: 4px
  field: 7px
  cta: 9px
  card: 16px
spacing:
  cta-x: 18
  cta-lg-y: 18
  cta-lg-x: 24
  field-x: 12
  card-y: 32
  card-inset: 48
components:
  header-cta:
    type: button
    backgroundColor: '#32d7b4'
    textColor: '#07111f'
    rounded: 9px
    padding: 0px 18px
    height: 42px
    typography: 14px / 900 Pretendard
    shadow: rgba(37, 216, 178, 0.15) 0px 8px 24px 0px
    hover: 'label #ffffff, fill stays #32d7b4'
    pressed: 'label #ffffff, fill stays #32d7b4'
    states: 'probe on both mildang.kr pages: hover and pressed turn the label white after a color 0.18s transition; focus draws only the browser default ring, so no brand focus style is declared'
    use: PT 신청하기 → in the header of mildang.kr and /service/ at surface-2::[data-omd-capture="5"], 144 x 42, linking to /shop/
  lead-cta:
    type: button
    backgroundColor: '#20c9a7'
    textColor: '#ffffff'
    rounded: 0px
    padding: 18px 24px
    height: 60px
    typography: 18px / 900 Pretendard, letter-spacing -0.4px
    hover: 'bg #3ad7b8, translateY(-2px)'
    pressed: 'bg #3ad7b8, translateY(-2px)'
    states: 'probe: hover and pressed settle on #3ad7b8 and lift 2px after a 0.25s background and transform transition; focus draws only the browser default ring'
    use: 무료 상담 신청하기 near the foot of mildang.kr/service/ at surface-3::[data-omd-capture="6"], 260 x 60, jumping to the lead form
  form-submit:
    type: button
    backgroundColor: '#16bea8'
    textColor: '#ffffff'
    rounded: 7px
    padding: 8px
    height: 54px
    typography: 18px / 700 / 20.7px Pretendard
    states: 'probe: hover and pressed gave no settled reading, so they are unmeasured; focus draws only the browser default ring'
    use: 무료 상담 신청( CLICK ) submit of the lead form on mildang.kr/service/ at surface-3::[data-omd-capture="9"], 200 x 54; never pressed or submitted
  home-form-submit:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 3px
    padding: 8px 16px
    height: 48px
    typography: 20px / 700 Pretendard
    hover: glow layer span#submit_glow opacity 0.125 -> 0.135
    states: 'probe: hover raises the glow layer''s opacity; pressed gave no settled reading (unmeasured); focus draws only the browser default ring'
    use: '무료 상담 신청( CLICK ) on the mildang.kr home lead form at surface-2::[data-omd-capture="8"], 240 x 48; its own fill is transparent and it sits on the #232952 form panel'
  lead-form-panel:
    type: card
    backgroundColor: '#232952'
    shadow: rgba(0, 0, 0, 0.5) 0px 4px 16px 0px
    use: Navy panel (div#md_form_inner) that holds the mildang.kr home lead form, read as the third ancestor of its submit button by the probe
  form-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#092532'
    border: '1px solid #c6d5d8'
    rounded: 7px
    padding: 0px 12px
    height: 54px
    typography: 14px / 400 Pretendard
    states: the collector's form-error pass re-read these fields with the same values as rest, so no field-level error style is declared
    use: Grade select and phone input of the lead form on mildang.kr/service/, 375 x 54
  home-form-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #777777'
    rounded: 3px
    padding: 8px 12px
    height: 48px
    typography: 16px / 400 Pretendard
    states: the collector's form-error pass re-read these fields with the same values as rest, so no field-level error style is declared
    use: Grade select and phone input of the lead form on the mildang.kr home, 418 x 48
  corporate-nav:
    type: tab
    textColor: '#15171c'
    padding: 12px 0px
    height: 42px
    typography: 15px / 700 Pretendard
    hover: 'fg #0064ff'
    pressed: 'fg #0064ff'
    states: bundle hover and pressed frames; focus not declared
    use: 회사소개, 사업소개, 뉴스룸 in the ihateflyingbugs.com header at home::[data-omd-capture="1"]
  language-select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#15171c'
    border: '1px solid #e0e3e8'
    rounded: 4px
    padding: 0px 28px 0px 14px
    height: 44px
    typography: 14px / 700 Pretendard
    hover: 'border #0064ff'
    pressed: 'border #0064ff'
    states: bundle hover and pressed frames; focus not declared
    use: 언어 선택 (한국어, English, Español) in the corporate header, 116 x 44
  hero-link:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 3px
    padding: 15px 19px 15px 22px
    height: 54px
    typography: 14px / 700 Pretendard
    states: the bundle's hover and pressed frames equal rest; the collector's focus frame is not used
    use: 아이헤이트플라잉버그스 소개 ↗ on the corporate hero at home::[data-omd-capture="5"], 246 x 54
  text-link:
    type: button
    textColor: '#15171c'
    border: '0 0 1px solid #15171c'
    padding: 10px 0px
    height: 43px
    typography: 14px / 700 / 22.4px Pretendard
    hover: 'fg and underline #0064ff'
    pressed: 'fg and underline #0064ff'
    states: bundle hover and pressed frames; focus not declared
    use: 밀당PT 만나보기 ↗ on the corporate 밀당PT page, 138 x 43, opening mildang.kr in a new tab
  service-subnav:
    type: tab
    textColor: '#666b76'
    height: 65px
    typography: 15px / 400 Pretendard
    selected: 'fg #0064ff at weight 700 (밀당PT on /mildang-pt/)'
    states: selected variant read from rest values; no pointer frame
    use: 스쿨PT, 밀당PT, AI 디지털교과서 sub-navigation on the corporate business pages
  review-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    shadow: rgba(0, 0, 0, 0.12) 0px 5px 32px 0px
    size: 316px x 426px
    use: Review carousel cards on the mildang.kr home (12 instances)
  history-row:
    type: card
    textColor: '#10212b'
    border: '0 0 1px solid #10212b'
    padding: 32px 0px 32px 48px
    size: 702px x 142px
    use: Ruled rows in the company-history section of mildang.kr/service/
  disclaimer-band:
    type: card
    backgroundColor: '#151520'
    textColor: '#aaaaaa'
    padding: 16px 24px 32px
    typography: 12px / 400 Pretendard
    use: Full-width source disclaimer at the foot of the mildang.kr home
fonts:
  roles:
    sans: Pretendard
---

# Milddang (I Hate Flying Bugs)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Milddang (I Hate Flying Bugs); reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/mildang/DESIGN.md
