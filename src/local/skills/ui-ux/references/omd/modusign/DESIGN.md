---
name: Modusign
colors:
  primary: '#fed05f'
  primary-hover: '#ffd80a'
  primary-border: '#ffc533'
  primary-border-deep: '#ffb90a'
  primary-tint: '#fff8e6'
  plan-blue: '#217aff'
  blue-label: '#4b75e7'
  gov-navy: '#08236d'
  headline: '#111111'
  ink: '#212121'
  body: '#333333'
  secondary: '#474747'
  gray-700: '#5c5c5c'
  muted: '#707070'
  faint: '#999999'
  tab-inactive: '#d3d3d3'
  black: '#000000'
  dark-fill: '#1a1a1a'
  canvas: '#ffffff'
  surface: '#fafafa'
  surface-alt: '#f5f5f5'
  hairline-faint: '#f0f0f0'
  hairline: '#e6e6e6'
  hairline-strong: '#cccccc'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.4px'
    use: Home hero headline (h1.new-display-hero), set in white
  display:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.4px'
    use: Page headline on /pricing and /features (h1)
  closing:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.4px'
    use: Closing consultation headline on the home page (h2)
  section:
    fontSize: 45px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.4px'
    use: Section heading (h2) on /pricing and /features
  headline:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: '-0.72px'
    use: Home workflow headline (h2.main-headline)
  tab-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.24px'
    use: Home product tab title (h3.tab-title)
  body-lg:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.4px'
    use: Home hero subline (new-body-lg)
  body-md:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.4px'
    use: Feature description copy on /features
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.4px'
    use: Document default body text
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: '-0.4px'
    use: 52px action label
  button-sm:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.83
    letterSpacing: '-0.4px'
    use: 44px header action label
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  badge: 24px
  toggle: 100px
spacing:
  cta-sm-y: 8
  cta-sm-x: 16
  cta-y: 12
  cta-x: 24
  banner-y: 30
  banner-x: 36
  card: 36
  feature-y: 48
  feature-x: 56
components:
  header-cta:
    type: button
    backgroundColor: '#fed05f'
    textColor: '#000000'
    border: '1px solid #ffc533'
    rounded: 6px
    padding: 8px 16px
    height: 44px
    typography: 14px / 700 / 25.6px Pretendard
    hover: 'bg #ffd80a'
    pressed: 'bg #ffd80a'
    states: 'rest, hover and pressed; the header copy on each of the three pages (capture 4 on each) settles on #ffd80a in both frames, as do the page-body yellow actions; focus is not declared from the capture'
    use: 무료 체험 시작 in the header at home::[data-omd-capture="4"], 110 x 44; repeated on /pricing and /features
  header-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 6px
    padding: 8px 16px
    height: 44px
    typography: 14px / 700 / 25.6px Pretendard
    hover: 'bg #f5f5f5'
    pressed: 'bg #f5f5f5'
    states: 'rest, hover and pressed; the header copy on each of the three pages settles on #f5f5f5; focus is not declared from the capture'
    use: 도입 문의 beside the yellow action at home::[data-omd-capture="3"], 84 x 44
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    padding: 8px 16px
    height: 42px
    typography: 16px / 400 / 25.6px Pretendard
    states: rest only; no state frame was recorded
    use: Header text link (블로그) at home::[data-omd-capture="1"], 72 x 42; the sign-in link beside it was read for style and never followed
  hero-cta:
    type: button
    backgroundColor: '#fed05f'
    textColor: '#000000'
    border: '1px solid #ffc533'
    rounded: 8px
    padding: 12px 24px
    height: 52px
    typography: 16px / 700 / 25.6px Pretendard
    hover: 'bg #ffd80a'
    pressed: 'bg #ffd80a'
    states: 'rest, hover and pressed; home captures 7 and 18 and /features capture 7 all settle on #ffd80a; focus is not declared from the capture'
    use: Page-body 무료 체험 시작 action at home::[data-omd-capture="7"], 137 x 52
  outline-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 8px
    padding: 12px 24px
    height: 52px
    typography: 16px / 700 / 25.6px Pretendard
    hover: 'bg #f5f5f5'
    pressed: 'bg #f5f5f5'
    states: 'rest, hover and pressed; home captures 6 and 17 and /features captures 6 and 16 settle on #f5f5f5; focus is not declared from the capture'
    use: Outlined consultation action paired with the yellow one at home::[data-omd-capture="6"], 107 x 52
  dark-cta:
    type: button
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    border: '1px solid #cccccc'
    rounded: 8px
    padding: 12px 24px
    height: 52px
    typography: 16px / 600 / 25.6px Pretendard
    hover: 'bg #212121'
    pressed: 'bg #212121'
    states: 'rest, hover and pressed; home captures 8 and 13 both settle on #212121; focus is not declared from the capture'
    use: Dark action on the home page at home::[data-omd-capture="8"], 182 x 52; capture 13 is a 148 x 50 sibling
  black-cta:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    border: '1px solid #000000'
    rounded: 8px
    padding: 12px 24px
    height: 52px
    typography: 16px / 700 / 25.6px Pretendard
    hover: 'bg #333333'
    pressed: 'bg #333333'
    states: 'rest, hover and pressed; /pricing capture 9 and /features capture 22 both settle on #333333; focus is not declared from the capture'
    use: Black plan action on /pricing at surface-2::[data-omd-capture="9"], 299 x 52
  plan-blue-cta:
    type: button
    backgroundColor: '#217aff'
    textColor: '#ffffff'
    border: '1px solid #217aff'
    rounded: 8px
    padding: 12px 24px
    height: 52px
    typography: 16px / 700 / 25.6px Pretendard
    states: 'one element; its hover and pressed frames both read #0e6eff, but with no sibling to agree the value is not declared as a state'
    use: Action on the recommended plan card at surface-2::[data-omd-capture="8"], 299 x 52
  plan-free-cta:
    type: button
    backgroundColor: '#fafafa'
    textColor: '#212121'
    border: '1px solid #999999'
    rounded: 8px
    padding: 12px 24px
    height: 52px
    typography: 16px / 700 / 25.6px Pretendard
    states: 'one element; its hover and pressed frames read #f5f5f5, not declared without a sibling'
    use: Free-plan action on /pricing at surface-2::[data-omd-capture="7"], 299 x 52
  plan-outline-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #cccccc'
    rounded: 8px
    padding: 8px 24px
    height: 44px
    typography: 16px / 700 / 25.6px Pretendard
    hover: 'bg #f5f5f5'
    pressed: 'bg #f5f5f5'
    states: 'rest, hover and pressed; the three plan-detail actions (captures 12, 13 and 14) all settle on #f5f5f5; focus is not declared from the capture'
    use: Plan-detail action on /pricing at surface-2::[data-omd-capture="12"], 173 x 44
  gov-cta:
    type: button
    backgroundColor: '#08236d'
    textColor: '#ffffff'
    border: '1px solid #cccccc'
    rounded: 8px
    padding: 8px 24px
    height: 44px
    typography: 16px / 700 / 25.6px Pretendard
    states: rest only; no state frame was recorded
    use: Public-sector plan action on /pricing at surface-2::[data-omd-capture="15"], 173 x 44
  billing-toggle:
    type: toggle
    backgroundColor: transparent
    textColor: '#999999'
    rounded: 100px
    padding: 7px 0px 8px
    height: 41px
    typography: 16px / 400 / 25.6px Pretendard
    selected: 'bg #ffffff, fg #333333, weight 700, 1px solid #f0f0f0, 8px radius (capture 6, 133 x 43)'
    states: selected variant read from rest values (capture 6 against 5); the hover and pressed frames of capture 5 match its rest values in every compared property, so no state is declared
    use: Billing-period switch on /pricing at surface-2::[data-omd-capture="5"], 76 x 41
  pricing-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#999999'
    rounded: 8px
    padding: 12px 16px 0px
    height: 57px
    typography: 18px / 400 / 25.6px Pretendard
    selected: 'fg #212121, weight 700 (capture 17)'
    hover: 'bg #f0f0f0, fg #212121'
    pressed: 'bg #f0f0f0, fg #212121'
    states: 'rest, hover and pressed; captures 18 and 19 settle on the same values and the selected tab (capture 17) takes the same #f0f0f0 fill; focus is not declared from the capture'
    use: Plan-comparison tab on /pricing at surface-2::[data-omd-capture="18"], 105 x 57
  feature-tab:
    type: tab
    textColor: '#d3d3d3'
    typography: 24px / 700 / 33.6px Pretendard
    selected: 'fg #111111 on the first title (모두싸인 전자서명)'
    states: selected variant read from the rest values of three titles; no pointer frame
    use: Product tab titles on the home page (h3.tab-title), 24px with -0.24px tracking
  feature-sticky-menu:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#5c5c5c'
    rounded: 12px
    padding: 16px
    height: 58px
    typography: 18px / 400 / 25.6px Pretendard
    hover: 'bg #fffae0'
    pressed: 'bg #fffae0'
    states: 'rest, hover and pressed; captures 12, 13 and 14 all settle on #fffae0; focus is not declared from the capture'
    use: Sticky section menu on /features at surface-3::[data-omd-capture="12"], 251 x 58
  pricing-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e6e6e6'
    rounded: 12px
    use: Plan card on /pricing (div.pricing-card-6), 349 wide; a 40px 24px header over rows padded 16px 24px
  popular-pricing-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #217aff'
    rounded: 12px
    shadow: rgba(33, 122, 255, 0.3) 0px 0px 20px 0px
    use: 'Recommended plan card on /pricing, 349 x 877, topped by a #e9f2ff badge strip (12px 12px 0 0 radius, 4px 12px padding)'
  stat-card:
    type: card
    backgroundColor: transparent
    border: '1px solid #e6e6e6'
    rounded: 12px
    padding: 36px 36px 52px
    size: 381px x 180px
    use: 'Statistic card on the home page (div.new-main-stat-card), three in a row; its label (기업 및 기관 회원) is 18px / 400 #474747'
  cta-banner:
    type: card
    backgroundColor: '#fed05f'
    textColor: '#212121'
    border: '1px solid #ffb90a'
    rounded: 12px
    padding: 30px 36px
    size: 528px x 94px
    states: 'whole-card link; on one element its hover and pressed frames read #ffd80a, the value the yellow buttons settle on, but the banner itself is not declared as a state'
    use: Yellow 무료 체험 시작 banner at the foot of /pricing and /features (a.cta-card.bg-amber300, surface-2 capture 21)
  cta-banner-gray:
    type: card
    backgroundColor: '#f5f5f5'
    textColor: '#212121'
    border: '1px solid #f0f0f0'
    rounded: 12px
    padding: 30px 36px
    size: 528px x 94px
    states: 'whole-card link; its hover and pressed frames read #e6e6e6 on one element, so no state is declared'
    use: Grey consultation banner beside the yellow one (a.cta-card.bg-gray25, surface-2 capture 20)
  new-badge:
    type: badge
    backgroundColor: '#fff1cc'
    textColor: '#e0a100'
    rounded: 160px
    padding: 0px 8px
    height: 26px
    typography: 13px / 500 / 25.6px Pretendard
    use: NEW marker beside footer items (div.icon-new-badge), 42 x 26
  info-badge:
    type: badge
    backgroundColor: '#f0f2ff'
    textColor: '#4351e8'
    border: '1px solid #e2e9fe'
    rounded: 6px
    padding: 6px 12px
    typography: 13px / 500 / 16.9px Pretendard
    use: Label badge on the home page's additional-service rows (div.new-main-additional-badge), 225 x 36
  feature-card:
    type: card
    backgroundColor: '#fafafa'
    rounded: 12px
    padding: 48px 56px 64px
    use: 'Advanced-feature panel on /features (div.feature-advanced-card); its siblings fill with #333333 (API, white text), #fff8e6 (security) and #fffcf5 (branding)'
fonts:
  roles:
    sans: Pretendard
---

# Modusign

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Modusign; reproduced for educational reference. Full prose: https://oh-my-design.kr/modusign/design.md
