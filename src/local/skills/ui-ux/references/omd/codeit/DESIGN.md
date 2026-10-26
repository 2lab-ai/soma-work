---
name: Codeit
colors:
  primary: '#9933ff'
  on-primary: '#ffffff'
  ink: '#333236'
  muted: '#888893'
  violet-deep: '#760dde'
  lavender: '#b363fd'
  lilac: '#c47cfd'
  violet-mid: '#a64eff'
  label-ink: '#fbf5ff'
  white: '#ffffff'
  surface: '#f6f6f8'
  hairline: '#e5e5ea'
  border: '#dddee4'
  plum: '#3d1457'
  butter: '#fff3bc'
typography:
  hero:
    fontSize: 68px
    fontWeight: 800
    lineHeight: 1.21
    letterSpacing: '-1.5px'
    use: 'Home hero headline (5분마다 인생이 바뀐다), Pretendard ExtraBold, 82px line, in #333236; the only Pretendard text on the captured pages'
  membership-title:
    fontSize: 68px
    fontWeight: 700
    lineHeight: 1.24
    letterSpacing: '-1.5px'
    use: Membership page headline (코드잇 멤버십 구독), SpoqaHanSansNeo Bold, 84px line
  section-lg:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.29
    letterSpacing: '-1px'
    use: Large section headings on home (value, AI GURU, goal and up-selling sections), 62px line
  section:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.38
    letterSpacing: '-0.3px'
    use: The five-minute cycle heading on home, white over its dark band, 44px line
  title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.43
    letterSpacing: '-0.3px'
    use: Feature and card headings on home, the hero subtitle above the headline, and the topic list title on /explore, 40px line
  card-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.67
    letterSpacing: '-0.3px'
    use: Learner story card titles on home, 30px line
  button-lg:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.56
    letterSpacing: '-0.3px'
    use: Hero 무료 체험 시작하기 label, 28px line
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.69
    letterSpacing: '-0.3px'
    use: Plan and secondary action labels (멤버십 시작하기, 모든 IT 강의 보러가기), 27px line
  feature:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.69
    letterSpacing: '-0.3px'
    use: Feature rows in the membership comparison on /subscription, 27px line
  body:
    fontSize: 16px
    fontWeight: 400
    letterSpacing: '-0.3px'
    use: 'Document default on all three pages, SpoqaHanSansNeo in #333236; line height computes normal'
  nav:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.67
    letterSpacing: '-0.3px'
    use: Header 모든 강의 category menu, 25px line, label at 80% ink
  label:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.67
    letterSpacing: '-0.3px'
    use: Rounded feature labels on home, 25px line
  caption:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.71
    letterSpacing: '-0.3px'
    use: Legend lines of the five-minute cycle chart on home, 24px line
  button-sm:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.62
    letterSpacing: '-0.3px'
    use: Header 멤버십 안내 label, 21px line (weight 700 on /subscription)
rounded:
  sm: 6px
  md: 8px
  cta: 10px
  card: 16px
  lg: 20px
  tab: 22px
  plan: 24px
  tile: 28px
  label: 32px
  round: 9990px
spacing:
  cta-y: 10
  cta-x: 32
  button-y: 8
  button-x: 24
  tab-y: 8
  tab-x: 16
  card: 20
  plan-y: 32
  plan-x: 40
components:
  hero-cta:
    type: button
    backgroundColor: '#9933ff'
    textColor: '#ffffff'
    rounded: 10px
    padding: 10px 32px
    height: 48px
    typography: 18px / 700 / 28px SpoqaHanSansNeo, letter-spacing -0.3px
    shadow: rgba(0, 0, 0, 0.12) 0px 2px 18px 0px
    states: 'probe on home: hover and pressed change only the opacity of two pseudo-element layers (::before 1 -> 0, ::after 0 -> 1) over a 300ms transition; the layers'' colours were not recorded, so no hover colour is declared; focus (Tab #46) draws only the browser''s default ring'
    use: 무료 체험 시작하기 under the home hero at home::[data-omd-capture="45"], a 400 x 48 button inside its link
    focus: no visible change (measured 2026-10-16) on :focus-visible
  header-membership-button:
    type: button
    backgroundColor: '#9933ff'
    textColor: '#ffffff'
    rounded: 6px
    padding: 6px 12px 5px
    height: 32px
    typography: 13px / 500 / 21px SpoqaHanSansNeo (700 on /subscription)
    states: 'not declared: the bundle''s hover, pressed and focus frames read #982eff on /explore but #9933ff on /subscription, so they are not settled; the probe did not find the control on two loads'
    use: 멤버십 안내 in the header of all three pages at home::[data-omd-capture="16"], 85 x 32
  plan-cta:
    type: button
    backgroundColor: '#9933ff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 24px
    height: 45px
    typography: 16px / 500 / 27px SpoqaHanSansNeo
    states: 'not measured on the button itself: the probe matched the surrounding plan-card link for 멤버십 시작하기, and that card lifts 8px on hover and pressed; no hover colour is declared for the button'
    use: 멤버십 시작하기 inside the 6-month plan card on /subscription at surface-3::[data-omd-capture="24"], 352 x 45
  secondary-button:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.4)
    textColor: rgba(51, 50, 54, 0.8)
    border: 1px solid rgba(51, 50, 54, 0.2)
    rounded: 8px
    padding: 8px 24px
    height: 45px
    typography: 16px / 500 / 27px SpoqaHanSansNeo
    hover: 'bg rgba(51, 50, 54, 0.05), label #333236'
    pressed: 'bg rgba(51, 50, 54, 0.05), label #333236'
    states: 'probe on home: hover and pressed settle on a 5% ink wash and full-strength ink after a 300ms transition; focus (Tab #31) draws only the browser''s default ring'
    use: 모든 IT 강의 보러가기 under the category tiles on home at home::[data-omd-capture="31"], 189 x 45
  category-dropdown:
    type: button
    textColor: rgba(51, 50, 54, 0.8)
    rounded: 8px
    padding: 4px 8px
    height: 33px
    typography: 15px / 500 / 25px SpoqaHanSansNeo
    states: 'rest only: the bundle hover and pressed frames differ from rest only between two fully transparent fills, and the control was not probed; no state value is declared'
    use: 모든 강의 category menu in the header at home::[data-omd-capture="7"], 97 x 33, transparent fill
  playground-tab:
    type: tab
    textColor: rgba(51, 50, 54, 0.6)
    rounded: 22px
    padding: 8px 16px
    height: 43px
    typography: 16px / 500 / 27px SpoqaHanSansNeo
    selected: 'bg #9933ff, fg #ffffff'
    states: 'probe on home: neither the selected nor the unselected tab changes on hover, pressed or focus (Tabs #34 and #35); transition all 0s'
    use: Playground section tabs on home (수강 환경, 지원 기기) at home::[data-omd-capture="33"], 93 x 43, on a white 30px-radius track
  icon-button:
    type: button
    backgroundColor: '#ffffff'
    rounded: 9990px
    padding: 8px
    size: 44px x 44px
    shadow: rgba(51, 50, 54, 0.15) 0px 0px 0px 1px inset
    states: 'rest only: no state frame was recorded and the control was not probed'
    use: Round previous and next buttons of the playground section on home at home::[data-omd-capture="35"]
  search-input:
    type: input
    backgroundColor: '#f6f6f8'
    border: '1px solid #dddee4'
    rounded: 20px
    padding: 8px 16px 6px 45px
    height: 40px
    typography: 14px / 400 SpoqaHanSansNeo
    states: 'rest only: no state frame was recorded and the field was not probed or focused'
    use: Search field above the topic list on /explore at surface-2::[data-omd-capture="72"], 206 x 40
  topic-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e5e5ea'
    rounded: 16px
    padding: 20px
    size: 320px x 146px
    use: Course topic cards in the curated rows of /explore (28 instances)
  case-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    size: 362px x 304px
    use: Learner story cards on home (for example 개발도 게임처럼! 구글 개발자가 됐어요) at home::[data-omd-capture="37"]
  review-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 20px
    padding: 32px
    size: 356px x 360px
    use: Learner review cards on /subscription (32 instances)
  category-card:
    type: card
    backgroundColor: '#f6f6f8'
    rounded: 28px
    size: 116px x 144px
    shadow: rgba(51, 50, 54, 0.05) 0px 0px 0px 1px inset
    use: Category tiles under the home hero (코딩 기초 and the other tracks)
  subscription-card:
    type: card
    backgroundColor: '#ffffff'
    border: 2px solid rgba(51, 50, 54, 0.1)
    rounded: 24px
    padding: 32px 40px
    size: 432px x 528px
    shadow: rgba(0, 0, 0, 0.08) 0px 2px 14px 0px
    hover: translateY(-8px)
    pressed: translateY(-8px)
    states: 'probe on /subscription: hover and pressed lift the card 8px after a 300ms transition; focus (Tab #22) draws only the browser''s default ring'
    use: 6-month plan card on /subscription
  recommended-plan-frame:
    type: card
    backgroundColor: '#b363fd'
    border: '2px solid #b363fd'
    rounded: 24px
    size: 440px x 572px
    shadow: rgba(0, 0, 0, 0.2) 0px 4px 24px 0px
    use: Lavender frame around the annual plan card on /subscription; the white card inside it keeps 24px top corners
  feature-label:
    type: badge
    backgroundColor: '#9933ff'
    textColor: '#fbf5ff'
    rounded: 32px
    padding: 0px 12px
    height: 32px
    typography: 15px / 700 / 25px SpoqaHanSansNeo
    use: 'Rounded labels on the feature cards on home; the three labels fill #c47cfd, #a64eff and #9933ff'
  upselling-card:
    type: card
    rounded: 20px
    padding: 24px 32px
    size: 400px x 406px
    use: 'Up-selling cards at the foot of home, filled #fff3bc and #3d1457, at home::[data-omd-capture="42"] and [data-omd-capture="43"]'
fonts:
  roles:
    display: Pretendard
    body: SpoqaHanSansNeo
---

# Codeit

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Codeit; reproduced for educational reference. Full prose: https://oh-my-design.kr/codeit/design.md
