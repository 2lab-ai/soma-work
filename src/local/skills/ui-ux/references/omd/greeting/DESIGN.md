---
name: Greeting
colors:
  primary: '#1890ff'
  on-primary: '#ffffff'
  action-dark: '#0f0f0f'
  heading: '#27272a'
  ink-soft: '#171717'
  secondary: '#3f3f46'
  muted: '#71717a'
  faint: '#a1a1aa'
  plan-ink: '#09090b'
  link: '#0a58a1'
  white: '#ffffff'
  surface-soft: '#fcfcfc'
  surface: '#f4f4f5'
  hairline: '#e4e4e7'
typography:
  display-hero:
    fontSize: 60px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: '-0.6px'
    use: 'Home hero headline (채용 관리를 넘어 채용 성공으로), Pretendard SemiBold face at computed weight 400, 72px line, in #27272a; the closing band repeats it in #ffffff'
  section:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: '-0.48px'
    use: 'Section headlines on home and /pricing, Pretendard SemiBold face, 62.4px line, in #171717'
  band:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: '-0.36px'
    use: 'Band headlines on home and plan prices on /pricing, Pretendard SemiBold face, 43.2px line, in #27272a'
  statement:
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: 'Wide statement paragraph on home, Pretendard SemiBold face, 44.8px line, in #27272a'
  feature:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.56px'
    use: 'Feature panel headings on home and /pricing, Pretendard SemiBold face, 39.2px line, in #27272a'
  quote:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.24px'
    use: 'Customer quotes on home, Pretendard SemiBold face, 36px line, in #27272a'
  card-title:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.4px'
    use: 'Feature list titles on home and plan names on /pricing, Pretendard SemiBold face, 30px line, in #27272a'
  subline:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    use: 'Home hero subline, Pretendard Regular face, 32px line, in #71717a'
  stat:
    fontSize: 96px
    fontWeight: 400
    lineHeight: 1
    use: White statistic figures in the proof band on home, Pretendard Medium face, 96px line
  numeral:
    fontSize: 174.851px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-8.74px'
    use: 'Oversized white Poppins numeral in the proof band on home, 174.851px line, letter-spacing -8.74254px; a 137.235px #0f0f0f instance sits further down'
  eyebrow:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.16px'
    use: 'Eyebrow labels set as h1 and h2 (국내 1위 채용 관리 솔루션 in #3f3f46, section labels in #171717), Pretendard SemiBold face, 16px line'
  button:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.32px'
    use: Labels of the 50px buttons (무료 체험하기, 도입 문의하기, 서비스 소개서 다운로드), Pretendard SemiBold face, 16px line
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Header navigation labels, Pretendard SemiBold face, 24px line, in #171717'
  plan-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.8
    use: 'Plan feature lines on /pricing, Pretendard Regular face, 28.8px line, in #09090b'
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Descriptions on /pricing and in the home footer, Pretendard Medium face, 21px line, in #71717a'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.2
    use: 'Plan labels and feature notes on /pricing, Pretendard SemiBold face, 14.4px line, in #71717a'
  fine:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Footer legal line on home, Pretendard Regular face, 15.4px line, in #71717a'
rounded:
  button: 4px
  dialog-button: 6px
  card: 16px
  pill: 50px
  switch: 100px
spacing:
  cta-y: 14
  cta-x: 25
  nav-y: 18
  nav-x: 12
  pill-y: 8
  pill-x: 20
  bar-y: 10
  bar-x: 15
components:
  header-demo-button:
    type: button
    backgroundColor: '#1890ff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 5px 8px 5px 12px
    height: 36px
    typography: 16px / 400 / 28.8px Pretendard SemiBold
    hover: bg rgba(44, 147, 242, 0.8)
    pressed: bg rgba(44, 147, 242, 0.8)
    states: 'probe on home: hover and pressed settle on rgba(44, 147, 242, 0.8) with transition all 0s; focus (Tab #11) draws only the browser default ring, so no brand focus style is declared'
    use: 도입 문의 at the right end of the header on all three captured pages (home::[data-omd-capture="10"], 97 x 36)
  dark-button:
    type: button
    backgroundColor: '#0f0f0f'
    textColor: '#ffffff'
    rounded: 4px
    padding: 14px 20px 14px 25px
    height: 50px
    typography: 16px / 400 / 16px Pretendard SemiBold, letter-spacing -0.32px
    hover: 'bg #3f3f46 plus a 1px solid #e4e4e7 ::after border'
    pressed: 'bg #3f3f46 plus a 1px solid #e4e4e7 ::after border'
    states: measured on the /pricing instance 견적 문의하기 (transition all 0s); the home hero instance was covered by the promotion dialog, so its hover and pressed are unmeasured; focus draws only the browser default ring
    use: '도입 문의하기 in the home hero (151 x 50) and 견적 문의하기 on the /pricing plan cards (219 x 50); a #171717 fill variant appears on the lower /pricing card'
  light-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171717'
    rounded: 4px
    padding: 14px 20px 14px 25px
    height: 50px
    typography: 16px / 400 / 16px Pretendard SemiBold, letter-spacing -0.32px
    hover: 'bg #f4f4f5, label #0f0f0f'
    pressed: 'bg #f4f4f5, label #0f0f0f'
    states: measured on 도입 혜택 문의하기 (transition all 0s); focus draws only the browser default ring
    use: '도입 혜택 문의하기 on /pricing (181 x 50); the same white button carries a #0f0f0f label on 서비스 소개서 다운로드 and 1:1 맞춤 상담받기 and a #3f3f46 label on the hero 무료 체험하기, whose states were not reached'
  soft-button:
    type: button
    backgroundColor: '#fcfcfc'
    textColor: '#171717'
    rounded: 4px
    padding: 14px 25px
    height: 50px
    hover: 'bg #f4f4f5, label #0f0f0f'
    pressed: 'bg #f4f4f5, label #0f0f0f'
    states: measured on the first 무료 체험 시작 (transition all 0s); focus draws only the browser default ring
    use: 무료 체험 시작 on the /pricing plan cards (231 x 50 and 244 x 50)
  nav-item:
    type: tab
    textColor: '#171717'
    rounded: 4px
    padding: 18px 12px
    height: 36px
    typography: 16px / 400 / 24px Pretendard SemiBold
    hover: 'bg #f4f4f5'
    pressed: 'bg #f4f4f5'
    states: 'probe on 가격: the transparent item fills #f4f4f5 on hover and pressed; focus (Tab #8) draws only the browser default ring; no selected variant was observed'
    use: Header items 왜 그리팅인가, 제품, 솔루션, 고객 사례, 가격, 유용한 자료 and 로그인 on all three pages
  eyebrow-pill:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#3f3f46'
    rounded: 50px
    padding: 8px 20px
    height: 32px
    states: 'unmeasured: the promotion dialog covered the pill and the Tab walk did not reach it'
    use: 국내 1위 채용 관리 솔루션 above the home hero headline (198 x 32); its label is the page's h1, 16px Pretendard SemiBold face
  dark-pill:
    type: badge
    backgroundColor: '#0f0f0f'
    textColor: '#ffffff'
    rounded: 50px
    padding: 8px 20px
    use: 왜 그리팅인가 label above the /why-greeting hero, the dark counterpart of the home eyebrow pill
  billing-switch:
    type: tab
    backgroundColor: '#f4f4f5'
    rounded: 100px
    padding: 6px 8px
    height: 49px
    states: 'probe: no change on hover or pressed; focus (Tab #1) draws only the browser default ring'
    use: 월간 / 연간 (-10%) billing switch above the /pricing plan cards, 175 x 49
  promo-dialog-button:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.12)
    textColor: '#ffffff'
    rounded: 6px
    padding: 12px 16px
    height: 39px
    typography: 15px / 600 / 15px Pretendard SemiBold, letter-spacing -0.15px
    states: 'rest only: the dialog button was not probed, so no hover, pressed or focus value is declared'
    use: 그리팅 AX 보기 in the AI promotion dialog that was open over home at capture (123 x 39)
  feature-card:
    type: card
    rounded: 16px
    padding: 16px
    size: 702px x 694px
    use: 'Feature panel beside the 채용 홈페이지 빌더 list on home (home::[data-omd-capture="29"]); transparent at rest, with a #a1a1aa description line'
fonts:
  roles:
    display: Pretendard SemiBold
    text: Pretendard Medium
    body: Pretendard Regular
    numeral: Poppins
---

# Greeting

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Greeting; reproduced for educational reference. Full prose: https://oh-my-design.kr/greeting/design.md
