---
name: Payhere
colors:
  primary: '#0077fe'
  on-primary: '#ffffff'
  header-action: '#008cff'
  ink: '#000000'
  canvas: '#ffffff'
  navy: '#1c2638'
  deep-navy: '#101a2e'
  slate: '#2b3648'
  body-muted: '#5f6976'
  muted: '#919ba5'
  inactive: '#c1cad2'
  surface: '#f5f8fa'
  surface-alt: '#f4f8f9'
  line: '#e2e8ee'
  inverse: '#000000'
  selected-on-dark: '#33abff'
  night: '#0e1d40'
  badge-event: '#f96eae'
  badge-hot: '#ff5b46'
  badge-official: '#08d07e'
typography:
  display-xl:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.39
    letterSpacing: '-1px'
    use: 'Feature headline on the table-order page (NaverPlace sub-section), #0e1d40'
  display:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.375
    letterSpacing: '-1px'
    use: Terminal page hero title (h1) and the home dark-section title
  section:
    fontSize: 44px
    fontWeight: 700
    lineHeight: 1.41
    letterSpacing: '-1px'
    use: 'Section titles (SectionTitle h2); the #1c2638 variant keeps normal tracking'
  subsection:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-1px'
    use: Stand and hardware sub-titles (h3)
  title:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-1px'
    use: Scroll-slider titles and the 구입하기 → label
  card-title:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.38
    letterSpacing: '-1px'
    use: Category selector labels and blue section descriptions
  card-heading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-1px'
    use: Feature-card titles (#101a2e) and FAQ questions
  lead:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-1px'
    use: Section description under the title on the terminal page (#2b3648)
  tab:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: '-1px'
    use: Selected pill-tab label; unselected labels use weight 400
  body-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.5px'
    use: Feature-card description lines (#1c2638)
  button:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.5px'
    use: 자세히 보기 action label
  field:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Form inputs; they render in Arial because they do not inherit Noto Sans KR
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Document default on body (computed 16px line height)
  badge:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.5px'
    use: Category badges (BEST, EVENT, HOT)
  menu:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.86
    letterSpacing: '-1px'
    use: Footer category menu links (#c1cad2)
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.83
    letterSpacing: '-1px'
    use: Footer legal and external links
rounded:
  header: 5px
  field: 8px
  action: 12px
  float: 16px
  card: 24px
  pill: 30px
  badge: 50px
  capsule: 100px
spacing:
  header-x: 16
  pill-y: 12
  pill-x: 24
  field: 12
  card: 32
  contact-card: 48
components:
  purchase-button:
    type: button
    backgroundColor: '#0077fe'
    textColor: '#ffffff'
    rounded: 0px 0px 24px 24px
    padding: 24px 0px
    height: 96px
    width: 586px
    typography: 32px / 700 / 48px Noto Sans KR, letter-spacing -1px
    states: rest only; not probed
    use: 구입하기 → closing the two hardware cards on the home (capture 26)
  detail-button:
    type: button
    backgroundColor: '#0077fe'
    textColor: '#ffffff'
    rounded: 12px
    padding: 16px
    height: 50px
    width: 334px
    typography: 18px / 700 / 18px Noto Sans KR, letter-spacing -0.5px
    states: rest only; not probed
    use: 자세히 보기 under the three feature cards on the home (capture 32)
  header-button:
    type: button
    backgroundColor: '#008cff'
    textColor: '#ffffff'
    rounded: 5px
    padding: 0px 16px
    height: 40px
    typography: 16px / 700 / 16px Noto Sans KR
    hover: no change within the compared scope (self and three ancestor levels; transition 0s) (probe)
    pressed: no change within the compared scope (probe)
    use: 카드 단말기 in the header of all three pages; links to /hardware/
  header-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#008cff'
    rounded: 5px
    padding: 0px 16px
    height: 40px
    typography: 16px / 700 / 16px Noto Sans KR
    shadow: rgb(0, 140, 255) 0px 0px 0px 1px inset
    hover: no change within the compared scope (probe)
    pressed: no change within the compared scope (probe)
    use: 테이블 오더 in the header of all three pages; links to /table-order/
  header-text-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1c2638'
    rounded: 5px
    padding: 0px 12px
    height: 40px
    typography: 16px / 700 / 16px Noto Sans KR (label span)
    states: rest only; not probed
    use: The text link at the left of the two header buttons (로그인)
  pill-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#5f6976'
    rounded: 30px
    padding: 12px 24px
    height: 56px
    typography: 20px / 400 / 32px Noto Sans KR, letter-spacing -1px (label span)
    selected: 'bg #0077fe, label #ffffff at 20px / 700 (capture 13 on the home, 17 on table-order)'
    states: selected variant read from rest values (capture 13 against 14); no pointer frame
    use: 'Feature and industry pill tabs: NFC, 비대면 결제, 선불권 on the home; 한식 · 음식점 and others on table-order'
  toggle-tab:
    type: toggle
    backgroundColor: '#e2e8ee'
    textColor: '#5f6976'
    rounded: 30px
    padding: 12px 24px
    height: 56px
    typography: 20px / 400 / 32px Noto Sans KR (label span)
    selected: 'bg #ffffff, label #008cff at 20px / 700 (capture 32)'
    states: selected variant read from rest values (capture 32 against 33); no pointer frame
    use: 'POS-type and industry toggles in a #e2e8ee track (30px radius, 4px padding) on the terminal page'
  step-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#c1cad2'
    border: 'bottom 3px solid #c1cad2'
    padding: 16px 24px
    height: 67px
    typography: 20px / 700 / 32px Noto Sans KR, letter-spacing -1px
    selected: 'fg #0077fe with a 3px #0077fe bottom border (capture 40)'
    states: selected variant read from rest values (capture 40 against 41); no pointer frame
    use: The two onboarding steps on the terminal page (포스를 변경하려는 기존 사업자, 포스를 처음 사용하는 신규 사업자)
  category-card:
    type: card
    backgroundColor: '#f5f8fa'
    textColor: '#1c2638'
    rounded: 12px
    padding: 20px 0px
    height: 84px
    typography: 26px / 700 / 36px Noto Sans KR, letter-spacing -1px
    use: 카드 단말기, 테이블 오더, 키오스크 and 인터넷 패키지 selectors under the home hero (capture 9)
  category-badge:
    type: badge
    backgroundColor: '#0077fe'
    textColor: '#ffffff'
    rounded: 50px
    padding: 4px 8px 5px
    height: 25px
    typography: 16px / 700 / 16px Noto Sans KR, letter-spacing -0.5px
    use: 'BEST over a category card; EVENT uses #f96eae and HOT #ff5b46'
  hero-badge:
    type: badge
    backgroundColor: '#0077fe'
    textColor: '#ffffff'
    rounded: 50px
    padding: 8px 20px
    height: 44px
    typography: 18px / 700 / 28px Noto Sans KR, letter-spacing -0.5px
    use: 사장님 맞춤형 1:1 밀착 컨설팅 above the table-order hero title
  content-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #c1cad2'
    rounded: 24px
    padding: 48px
    use: 'Contact cards near the foot of the home; hardware and pricing cards use a 1px #e2e8ee border at the same radius'
  price-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e2e8ee'
    rounded: 24px
    padding: 36px 24px
    shadow: rgba(0, 0, 0, 0.08) 0px 3px 15px 0px
    use: Free-price cards on the terminal page, 384 x 172
  text-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#101a2e'
    border: '1px solid #e2e8ee'
    rounded: 8px
    padding: 12px
    height: 48px
    typography: 16px / 400 / 24px Arial
    states: rest only; focus was not measured
    use: 'Consultation form fields on the home and table-order; the first option of the table-order form carries a 1px #008cff border'
  form-submit:
    type: button
    backgroundColor: '#919ba5'
    textColor: '#ffffff'
    rounded: 8px
    padding: 16px 0px
    height: 58px
    typography: 18px / 700 Noto Sans KR, letter-spacing -1px
    states: the fill observed on an empty form (the disabled attribute was false); the form was never filled, so no other fill was observed
    use: 도입 문의하기 and 동의하고 무료 상담 submit buttons
  pricing-cta:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 100px
    padding: 16px 32px
    height: 60px
    typography: 18px / 700 / 28px Noto Sans KR, letter-spacing -1px
    states: rest only
    use: 도입 비용 계산해보기 on the table-order page (capture 15)
    pressed: opacity 0.9 (:hover + :active)
  floating-cta:
    type: button
    backgroundColor: 'linear-gradient(290.64deg, #163bd8 6.63%, #3da7ff 107.33%)'
    textColor: '#ffffff'
    rounded: 50px
    height: 64px
    width: 384px
    shadow: rgba(0, 0, 0, 0.21) 0px 4px 12px 0px
    typography: 20px / 700 / 32px Noto Sans KR, letter-spacing -1px (label span)
    hover: no change within the compared scope (self, one descendant, three ancestor levels; transition 0s) (probe)
    pressed: no change within the compared scope (probe)
    use: 지금 25% 할인받기, floating at the foot of the terminal page; its fill is a background-image gradient, not a background colour
  floating-secondary:
    type: button
    backgroundColor: '#f5f8fa'
    textColor: '#0077fe'
    border: '1px solid #f5f8fa'
    rounded: 50px
    height: 64px
    width: 384px
    shadow: rgba(0, 0, 0, 0.21) 0px 4px 12px 0px
    hover: no change within the compared scope (probe)
    use: 올인원 카드 단말기 beside the floating CTA
  carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #c1cad2'
    rounded: 100%
    height: 48px
    width: 48px
    hover: 'border #111111; both arrows read the same value in their hover and pressed frames'
    pressed: 'border #111111'
    use: Seller-review carousel arrows on the terminal page (captures 6 and 7)
  floating-button:
    type: button
    backgroundColor: '#ffffff'
    rounded: 16px
    height: 80px
    width: 80px
    shadow: rgba(0, 0, 0, 0.21) 0px 4px 12px 0px
    states: rest only
    use: The chat floating button on every page; back-to-top on the home and the terminal page
  contact-card:
    type: card
    backgroundColor: '#0e1d40'
    textColor: '#ffffff'
    rounded: 24px
    padding: 64px 0px
    height: 205px
    width: 384px
    use: '채팅 상담 card on the terminal page; 전화 상담 and 희망일 상담 use #f5f8fa with #0c4a6e text'
  download-button:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #919ba5'
    rounded: 8px
    height: 72px
    width: 241px
    states: rest only
    use: 'The four POS download buttons on the home (label 18px / 400 in #1c2638)'
fonts:
  roles:
    primary: Noto Sans KR
---

# Payhere

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Payhere; reproduced for educational reference. Full prose: https://oh-my-design.kr/payhere/design.md
