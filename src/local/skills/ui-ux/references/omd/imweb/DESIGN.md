---
name: Imweb
colors:
  primary: '#15181e'
  ink: '#15181e'
  canvas: '#ffffff'
  on-primary: '#ffffff'
  text-secondary: '#4b515b'
  muted: '#717680'
  faint: '#bcc0c6'
  link: '#0090d4'
  surface: '#f8f9fb'
  eyebrow-magenta: '#ff50da'
  eyebrow-green: '#008c00'
typography:
  display-hero:
    fontSize: 80px
    fontWeight: 700
    lineHeight: 1
    use: Rotating hero keyword on imweb.me
  display:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.25
    use: Pricing headline (h2)
  display-template:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.72px'
    use: Template gallery headline (h1)
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.48
    use: Home section heading
  feature:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.48
    use: Feature heading on home (디자인이 쉬워요)
  price:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.2
    use: Plan price figure
  eyebrow:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Coloured eyebrow (h2) above a page headline
  faq-question:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: FAQ question on the pricing page
  group-title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.15px'
    use: Template group title on the template gallery
  lead:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Hero sub line on home, in #717680'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body text, Pretendard
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Header navigation, imweb Sans
  button:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.71
    use: Header action labels, imweb Sans
  button-lg:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: Plan card action labels, imweb Sans
  hero-button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '-0.08px'
    use: Home action label, Pretendard
  tab:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.57
    letterSpacing: '-0.035px'
    use: Template category tab, Pretendard
  label:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: Plan promo strip label, imweb Sans
rounded:
  md: 8px
spacing:
  nav-y: 24
  cta-x: 12
  cta-lg-x: 16
  tab-x: 12
  faq-y: 28
  faq-x: 32
components:
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#15181e'
    padding: 24px 0px
    height: 72px
    typography: 16px / 400 / 24px imweb Sans
    hover: 'fg #717680'
    pressed: 'fg #717680'
    selected: weight 700 on the current page's link (템플릿 on /theme, 요금 on /price)
    states: 'rest, hover, pressed and selected; all six header links (capture 1-6) read fg #717680 in both frames on all three surfaces; selected read from rest values; focus is not declared from the capture'
    use: Header navigation (주요기능, 템플릿, 요금, 전문가 찾기, 스토리, 고객지원) at home::[data-omd-capture="1"], 75 x 72
  header-login:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#4b515b'
    rounded: 8px
    padding: 8px 12px
    height: 40px
    typography: 14px / 600 / 24px imweb Sans
    states: rest on all three surfaces; no state frame
    use: 로그인 link styled as a button at home::[data-omd-capture="7"], 64 x 40; read, never followed
  header-cta:
    type: button
    backgroundColor: '#15181e'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 12px
    height: 40px
    typography: 14px / 600 / 24px imweb Sans
    states: rest on all three surfaces; a focus frame was recorded but focus is not declared from the capture
    use: 무료로 시작하기 in the header at home::[data-omd-capture="8"], 112 x 40
    pressed: 'bg #4b515b (:hover + :active)'
    focus: no visible change (measured 2026-10-16) on :focus-visible
  hero-cta:
    type: button
    backgroundColor: '#15181e'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 16px
    height: 48px
    typography: 16px / 500 / 24px Pretendard
    states: rest on two siblings (capture 54 and 59); no state frame
    use: 지금 무료로 시작하기 below the template carousel and in the closing band at home::[data-omd-capture="54"], 163 x 48; label tracking -0.08px
  plan-cta-primary:
    type: button
    backgroundColor: '#15181e'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    height: 48px
    typography: 16px / 600 / 24px imweb Sans
    states: rest; a focus frame was recorded but focus is not declared from the capture
    use: Plan card action (14일 무료 체험 시작하기) on the pricing page at surface-3::[data-omd-capture="16"], 314 x 48
  plan-cta-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#4b515b'
    rounded: 8px
    padding: 12px 16px
    height: 48px
    typography: 16px / 600 / 24px imweb Sans
    states: rest only; no state frame
    use: Plan card action (14일 무료 체험 시작하기) on the other plans at surface-3::[data-omd-capture="13"], 314 x 48; the collector records a 0px border and does not read outline, so no edge is claimed
  plan-promo-strip:
    type: badge
    backgroundColor: rgba(0, 185, 255, 0.1)
    textColor: '#0090d4'
    rounded: 8px 8px 0px 0px
    padding: 8px 0px
    height: 40px
    typography: 16px / 600 / 24px imweb Sans
    states: rest on two plan cards (capture 14 and 17)
    use: 'Strip across the top of a plan card (PG 가입비 면제 마감 임박) at surface-3::[data-omd-capture="14"], 346 x 40; the label is a p.clay-label-large-bold in #0090d4'
  template-category-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#15181e'
    rounded: 8px
    padding: 0px 12px
    height: 40px
    typography: 14px / 500 / 22px Pretendard
    selected: 'bg #15181e, fg #ffffff (capture 10, aria-selected true; the clicked tabs tab-0-0 and tab-1-0 read the same)'
    states: selected read from rest values and two clicked tabs; one element's hover and pressed frames read a mid-transition fill with no sibling to agree, so no hover is declared; focus is not declared from the capture
    use: Template category tabs on the template gallery at surface-2::[data-omd-capture="11"], 100 x 40; label tracking -0.035px
  billing-period-option:
    type: tab
    backgroundColor: transparent
    textColor: '#6b7280'
    padding: 6px 12px
    height: 33px
    typography: 14px / 500 / 21px Pretendard
    states: 'rest values only; the 1년 option (capture 10, with its 1개월 보다 20% 저렴해요 note) reads #000000 against #6b7280 on 1개월 and 2년; no pointer frame'
    use: Billing-period switch above the plan cards at surface-3::[data-omd-capture="9"], 151 x 33
  faq-row:
    type: card
    backgroundColor: '#f8f9fb'
    textColor: '#15181e'
    rounded: 8px
    padding: 28px 32px
    height: 88px
    typography: 16px / 400 / 24px Pretendard
    states: rest only; rows were not expanded
    use: 'FAQ accordion row on the pricing page at surface-3::[data-omd-capture="82"], 1280 x 88; question 20px / 700 / 28px in #15181e; six rows captured'
  ai-prompt-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#15181e'
    padding: 2px
    height: 80px
    typography: 16px / 400 / 24px Pretendard
    states: rest only; never typed into or submitted
    use: imweb AI prompt textarea in the home hero at home::[data-omd-capture="10"], 688 x 80; the placeholder asks for at least 25 characters
  ai-mode-chip:
    type: button
    backgroundColor: rgba(0, 185, 255, 0.15)
    textColor: '#15181e'
    rounded: 8px
    padding: 6px 12px
    height: 36px
    typography: 16px / 400 Pretendard
    states: rest only; one element
    use: 단계별로 만들기 button at the top right of the imweb AI box at home::[data-omd-capture="9"], 134 x 36
  ai-send-button:
    type: button
    backgroundColor: rgba(113, 118, 128, 0.05)
    textColor: '#bcc0c6'
    rounded: 3.35544e+07px
    padding: 8px
    size: 32px x 32px
    states: recorded as disabled while the prompt is empty; no enabled state was captured
    use: Send button of the imweb AI box at home::[data-omd-capture="11"]; the radius computes to 3.35544e+07px, i.e. fully round
  footer-social-link:
    type: button
    backgroundColor: rgba(113, 118, 128, 0.05)
    rounded: 3.35544e+07px
    size: 36px x 36px
    states: rest only
    use: Fully round footer social links at home::[data-omd-capture="90"]; the same three appear on the template gallery and the pricing page
fonts:
  roles:
    ui: imweb Sans
    body: Pretendard
---

# Imweb

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Imweb; reproduced for educational reference. Full prose: https://oh-my-design.kr/imweb/design.md
