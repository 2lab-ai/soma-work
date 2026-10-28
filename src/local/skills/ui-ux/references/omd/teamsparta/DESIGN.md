---
name: Team Sparta
colors:
  primary: '#fa0030'
  on-primary: '#ffffff'
  ink: '#0c0e13'
  slate: '#41414b'
  muted: '#858793'
  faint: '#a4a7b0'
  coral: '#ff4660'
  hero-aqua: '#93e6f5'
  on-dark-soft: '#e0e1e5'
  category-red: '#d90b32'
  category-teal: '#0b495c'
  category-purple: '#8723ba'
  charcoal: '#1d1e22'
  surface: '#f5f6f7'
  surface-alt: '#f1f1f3'
  hover-tint: '#f9f9fb'
  canvas: '#ffffff'
typography:
  hero:
    fontSize: 50px
    fontWeight: 700
    lineHeight: 1.32
    letterSpacing: '-1px'
    use: 'Home hero headline (AI 시대, / 미래를 돌파하는 힘 / 스파르타클럽), Framer''s Pretendard Bold face, 66px line, in #ffffff over the hero media'
  stat:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.08
    use: 'Four statistic figures on home, Gmarket Sans TTF Bold, 52px line, in #0c0e13'
  display-band:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.35
    use: 'Headline of the red conversion band on home (지금 스파르타클럽에서 / 잠재력을 깨우세요.), 54px line, in #ffffff'
  step-number:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.3
    use: 'Red step numerals of the Total Career Solution section on home, 52px line, in #fa0030'
  section:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.375
    use: 'Section headings on home, Pretendard Bold face, 44px line, in #0c0e13 (#ffffff on dark bands); the course page''s h2 computes the same metrics in #0d0e11'
  section-sm:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.36
    use: 'Smaller section heading on home, 38px line, in #0c0e13'
  hero-sub:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.45
    use: 'Hero line above the headline (도전하는 누구나 잠재력을 깨울 수 있도록), 32px line, in #93e6f5'
  course-title:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.36
    use: 'Course title on the course page (오늘 배워 내일 바로 써먹는 ChatGPT 활용법), Pretendard, 30px line, in #000000'
  card-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.44
    use: 'Copy on the home category cards and step descriptions, 26px line, #ffffff on the cards and #0c0e13 in the step section'
  eyebrow:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.47
    letterSpacing: '-0.2px'
    use: 'Red eyebrow label on home (Total Career Solution), 22px line, -0.2px tracking, in #fa0030'
  label:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.47
    use: 'Supporting lines under home section headings, Pretendard Medium face, 22px line, in #858793 (#e0e1e5 on the dark band)'
  button:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.47
    use: 수강신청하기 and 더 많은 질문 보기 labels and the course tabs on the course page, Pretendard, 22px line
  footer:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.54
    use: 'Footer company and legal lines on home and the catalog, 20px line, in #a4a7b0'
  caption:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Footer company lines on the course page, Pretendard, 18px line, in #a4a7b0'
rounded:
  chip: 4px
  button: 6px
  card: 8px
  course-card: 16px
  cta: 38px
spacing:
  cta-y: 16
  cta-x: 20
  button-y: 8
  button-x: 12
  card-y: 24
  card-x: 18
  course-card: 32
  band-top: 80
components:
  enroll-cta:
    type: button
    backgroundColor: '#fa0030'
    textColor: '#ffffff'
    rounded: 38px
    padding: 16px 20px
    height: 56px
    typography: 15px / 700 / 22px Pretendard
    states: 'probe on the course page: hover and pressed show no change across the button and three ancestor levels; focus (Tab #2) draws only the browser''s default ring, so no brand focus style is declared; it computes transition width 0.2s ease-in-out'
    use: 수강신청하기, the enrolment action of the course page at surface-3::[data-omd-capture="1"], 320 x 56
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  course-tab:
    type: tab
    textColor: '#858893'
    border: 0px 0px 2px, bottom edge transparent at rest
    padding: 3px 0px 0px
    height: 53px
    typography: 15px / 700 / 22px Pretendard
    selected: 'fg #fa0030 with a 2px #fa0030 bottom border (강의소개 at capture 3)'
    states: 'selected variant read from rest values; hover and pressed are unmeasured because the fixed utility bar covered the pointer target; focus (Tabs #4 and #5) draws only the browser''s default ring'
    use: Section tabs of the course page (강의소개, 커리큘럼 and three more) at surface-3::[data-omd-capture="4"]; product surface
  review-button:
    type: button
    backgroundColor: '#0c0e13'
    rounded: 6px
    padding: 8px 12px
    height: 36px
    states: 'hover and pressed unmeasured (the probe''s pointer landed on the h5 label and :hover did not match); focus (Tab #28) draws only the browser''s default ring'
    use: 후기 자세히 보기 under the review cards on home at home::[data-omd-capture="24"], 109 x 36 (five instances); the label sits in a Framer h5 whose colour the collector did not record, so no fg is declared
  enterprise-button:
    type: button
    backgroundColor: '#0b495c'
    textColor: '#ffffff'
    rounded: 6px
    padding: 10px 12px
    height: 40px
    states: 'probe on home: hover shows no change; pressed changes only the Chromium default link colour of the anchor and its label wrappers, which is not a brand state; focus (Tab #23) draws only the browser''s default ring'
    use: 기업교육 알아보기 on home at home::[data-omd-capture="19"], 125 x 40; the white label is the collector's recorded label colour
  nav-item:
    type: tab
    textColor: '#0c0e13'
    rounded: 0px (6px on hover)
    padding: 8px 10px
    height: 40px
    hover: 'bg #f9f9fb, radius 6px'
    states: 'hover settles on a #f9f9fb fill with a 6px radius (probe and bundle frame agree on the radius); pressed adds only the Chromium default link colour; focus (Tab #6) draws only the browser''s default ring'
    use: Header navigation (전체 강의, 취업 캠프, 재직자 캠프, 커뮤니티, 수강후기, 이벤트) on home and the catalog at home::[data-omd-capture="5"]; the label colour is the collector's recorded label colour
  category-card:
    type: card
    backgroundColor: '#d90b32'
    textColor: '#ffffff'
    rounded: 16px
    padding: 32px 32px 48px
    size: 373px x 460px
    variants: '#0b495c (AI 입문), #8723ba (직장인 스킬업)'
    use: 'Three linked course-category cards at the top of home (AI 시대 취업 캠프 in #d90b32 at capture 15, AI 입문 in #0b495c at 16, 직장인 스킬업 in #8723ba at 17); the bundle''s hover frames record a transform change whose value was not recorded'
  conversion-band:
    type: card
    backgroundColor: '#fa0030'
    textColor: '#ffffff'
    padding: 80px 0px 40px
    size: 1440px x 547px
    use: Full-bleed red band near the foot of home at home::[data-omd-capture="29"]; the whole band is one link carrying 지금 스파르타클럽에서 잠재력을 깨우세요.
  catalog-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#0c0e13'
    rounded: 8px
    padding: 24px 18px
    size: 371px x 399px
    use: Course cards under 이번 달 가장 많이 신청한 강의 on the catalog at surface-2::[data-omd-capture="10"] (three instances)
  more-button:
    type: button
    backgroundColor: '#f5f6f7'
    rounded: 8px
    padding: 12px 0px
    height: 48px
    states: rest on three captured instances; no state frame and no probe, so no state is declared
    use: 더보기 inside each catalog course card at surface-2::[data-omd-capture="11"], 335 x 48; the label colour was not recorded
  dark-cta:
    type: button
    backgroundColor: '#1d1e22'
    textColor: '#ffffff'
    rounded: 8px
    padding: 14px 12px
    height: 52px
    states: rest on two captured instances; no state frame and no probe
    use: 발급 가이드 확인하기 and 문의하기 on the catalog at surface-2::[data-omd-capture="23"], 260 x 52
  faq-button:
    type: button
    backgroundColor: '#f1f1f3'
    textColor: '#000000'
    rounded: 8px
    height: 48px
    typography: 15px / 700 / 22px Pretendard
    states: 'probe on the course page: hover and pressed show no change; focus (Tab #17) draws only the browser''s default ring'
    use: 더 많은 질문 보기 under the FAQ of the course page at surface-3::[data-omd-capture="16"], 237 x 48
  learn-more-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    padding: 8px 12px
    height: 30px
    states: 'probe on the course page: hover and pressed show no change; focus (Tab #12) draws only the browser''s default ring'
    use: 더 알아보기 on the dark promotion panel of the course page (더 많은 활용법을 알고 싶다면?) at surface-3::[data-omd-capture="11"], 84 x 30; it computes the browser's default button face, so no font is declared
fonts:
  roles:
    display: Pretendard
    body: Pretendard
    accent: Gmarket Sans
---

# Team Sparta

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Team Sparta; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/teamsparta/DESIGN.md
