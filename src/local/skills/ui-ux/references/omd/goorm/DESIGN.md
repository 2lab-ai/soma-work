---
name: goorm
colors:
  ink: '#262626'
  text-secondary: '#4c4c4c'
  text-muted: '#5d5d5d'
  text-tertiary: '#393939'
  primary: '#2a72e5'
  anchor: '#0957c8'
  link: '#0043b3'
  canvas: '#ffffff'
  surface: '#f7f7f7'
  hairline: '#e1e1e1'
  border-strong: '#c6c6c6'
  on-primary: '#ffffff'
  edu-ink: '#2b2d36'
  edu-body: '#3e404c'
typography:
  display:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.29
    letterSpacing: '-0.4px'
    use: Arkain page headline (h2)
  nav:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.71
    use: Global navigation item on www.goorm.io
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.57
    letterSpacing: '-0.1px'
    use: Header action label
  button-lg:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '-0.1px'
    use: Hero action label
  body:
    fontSize: 16px
    fontWeight: 400
    use: Marketing body text (line height computes normal)
  card-title:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: Customer story card title
  edu-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.096px'
    use: goormEDU body text
  edu-section:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.3px'
    use: goormEDU section heading (h3)
rounded:
  sm: 3px
  md: 8px
spacing:
  nav-y: 8
  nav-x: 12
  cta-x: 16
  cta-lg-x: 24
  card: 24
  menu: 4
components:
  header-nav-button:
    type: tab
    backgroundColor: transparent
    textColor: '#262626'
    rounded: 8px
    padding: 8px 12px
    height: 40px
    typography: 14px / 600 / 24px Pretendard
    states: hover and pressed frames read background oklab(0 0 0 / 0), still transparent although the class names hover:bg-v-gray-40, so they are treated as transition frames and no hover value is declared; the menu triggers open a captured menu
    use: Global navigation item on www.goorm.io (비즈니스 and 리소스 open menus; 채용 and 공지사항 are links) at home::[data-omd-capture="1"], 100 x 40; the Arkain page repeats the same values
  header-cta:
    type: button
    backgroundColor: '#262626'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 16px
    height: 40px
    typography: 14px / 500 / 22px Pretendard
    states: rest on home and the Arkain page (capture 7 on each); no state frame
    use: Header 도입 문의하기 action at home::[data-omd-capture="7"], 107 x 40
    focus: 'outline #262626 solid 2px on :focus-visible'
  hero-cta:
    type: button
    backgroundColor: '#262626'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 24px
    height: 48px
    typography: 16px / 500 / 24px Pretendard
    states: rest only; no state frame
    use: Hero action at home::[data-omd-capture="9"], 134 x 48; the Arkain page renders the same values on an a role=button (surface-2 capture 8)
  outline-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#262626'
    rounded: 8px
    padding: 0px 24px
    height: 48px
    typography: 16px / 500 / 24px Pretendard
    shadow: rgb(198, 198, 198) 0px 0px 0px 1px inset
    states: rest only; no state frame
    use: Secondary hero action on the Arkain page at surface-2::[data-omd-capture="9"], 148 x 48; its edge is a 1px inset shadow, not a border
  neutral-icon-button:
    type: button
    backgroundColor: '#e1e1e1'
    rounded: 8px
    size: 40px x 40px
    states: rest on two sibling buttons (capture 10, 11); no state frame
    use: Icon-only carousel buttons on the Arkain page at surface-2::[data-omd-capture="10"]
  product-demo-primary:
    type: button
    backgroundColor: '#2a72e5'
    rounded: 8px
    padding: 0px 16px
    height: 40px
    states: 'one element; its hover and pressed frames both read #1e5dcc, but with no sibling to agree the value is not declared as a state'
    use: Primary button inside the in-page product demo on www.goorm.io at home::[data-omd-capture="13"], 84 x 40; its label sits in a child that was not captured, so no text colour is claimed
  product-demo-navbar-button:
    type: button
    backgroundColor: transparent
    rounded: 8px
    size: 32px x 32px
    hover: 'bg #f0f0f0'
    pressed: 'bg #f0f0f0'
    states: 'rest, hover and pressed; four sibling buttons (capture 11, 17, 18, 19) all read #f0f0f0 in both frames; focus is not declared from the capture'
    use: Icon button in the product demo's navigation bar at home::[data-omd-capture="11"]
  customer-story-card:
    type: card
    backgroundColor: '#f7f7f7'
    border: '1px solid #e1e1e1'
    rounded: 8px
    padding: 24px
    size: 352px x 420px
    use: 'Customer story card (article.customer-story-card) on home and the Arkain page; title 20px / 500 / 30px #262626, description 16px / 500 / 24px #5d5d5d, footer divided by a 1px #e1e1e1 top border'
  patent-card:
    type: card
    backgroundColor: '#f7f7f7'
    border: '1px solid #e1e1e1'
    rounded: 8px
    padding: 24px
    size: 369px x 130px
    use: 'Patent card (article.patent-card) on home, eight captured; title 16px / 500 / 24px #262626'
  dropdown-menu:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e1e1e1'
    rounded: 8px
    padding: 4px
    shadow: color(srgb 0 0 0 / 0.2) 0px 4px 10px 0px
    use: Menu panel (role=menu) opened by the collector from a header trigger (interaction capture menu-0-0), 160 wide; its items are 14px / 400 / 22px with 8px radius and 4px 8px padding
  edu-primary-button:
    type: button
    backgroundColor: '#393939'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 24px
    height: 48px
    typography: 16px / 500 / 24px Pretendard Variable
    states: rest captured; the pressed frame adds only a transparent zero-size box-shadow, a transition frame, so no pressed value is declared; no hover frame; focus is not declared from the capture
    use: Vapor UI button on edu.goorm.io at surface-3::[data-omd-capture="17"], 133 x 48
  edu-search-input:
    type: input
    backgroundColor: '#f7f7fa'
    textColor: '#2b2d36'
    rounded: 8px
    padding: 0px 32px 0px 0px
    height: 32px
    typography: 14px / 400 / 22px Pretendard Variable
    states: rest only; no state frame
    use: Header search field on edu.goorm.io (Vapor UI input) at surface-3::[data-omd-capture="7"], 347 x 32
  edu-header-link:
    type: tab
    backgroundColor: transparent
    textColor: '#2b2d36'
    height: 36px
    typography: 16px / 500 / 24px Pretendard Variable
    hover: 'fg #1d6ce0'
    pressed: 'fg #1d6ce0'
    states: 'rest, hover and pressed; siblings (capture 11, 12 and the smaller capture 8) all read #1d6ce0 in both frames; focus is not declared from the capture'
    use: Primary header link on edu.goorm.io at surface-3::[data-omd-capture="11"], 55 x 36
  edu-course-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#4c4c4c'
    border: 2px solid transparent (bottom only)
    padding: 14px 4px 12px
    height: 50px
    typography: 16px / 400 / 24px Pretendard Variable
    selected: 'fg #2a72e5, weight 500, 2px bottom border #2a72e5 (capture 14)'
    states: selected variant read from rest values (capture 14 against 15); no pointer frame
    use: Course category tab on edu.goorm.io at surface-3::[data-omd-capture="15"], 100 x 50
  family-bar-link:
    type: tab
    backgroundColor: transparent
    textColor: '#262626'
    typography: 12px / 400 / 18px Pretendard Variable
    selected: 'fg #0043b3, weight 700 on the current service (capture 0)'
    states: selected variant read from rest values (capture 0 against 1-3); no pointer frame
    use: goorm family-service switcher at the top of edu.goorm.io at surface-3::[data-omd-capture="1"]
  family-bar-account-link:
    type: button
    backgroundColor: transparent
    textColor: '#5d5d5d'
    typography: 12px / 400 / 20px Pretendard Variable
    hover: 'fg #0043b3'
    pressed: 'fg #0043b3'
    states: 'rest, hover and pressed; both links (capture 4, 5) read #0043b3 in both frames; focus is not declared from the capture'
    use: Account links at the right end of the family bar on edu.goorm.io at surface-3::[data-omd-capture="4"]; styles were read without following the links
fonts:
  roles:
    sans: Pretendard
    product: Pretendard Variable
---

# goorm

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to goorm; reproduced for educational reference. Full prose: https://oh-my-design.kr/goorm/design.md
