---
name: Kia
colors:
  ink: '#05141f'
  primary: '#05141f'
  primary-deep: '#010e18'
  canvas: '#ffffff'
  surface: '#f8f8f8'
  body: '#37434b'
  muted: '#697278'
  muted-alt: '#79838b'
  outline: '#9fa5a9'
  disabled: '#dadbdc'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 52px
    fontWeight: 400
    lineHeight: 1.23
    use: Vehicle hero title on the EV6 page (h2.main-title), Kia Signature Bold
  display:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 1.25
    use: Section teaser titles on the EV6 page (h2.cmp-teaser__title), Kia Signature Bold
  section:
    fontSize: 42px
    fontWeight: 400
    lineHeight: 1.29
    use: Home section heading (Best Kia), Kia Signature Bold
  subsection:
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.43
    use: Model name at the head of the EV6 sub-navigation, Kia Signature Bold
  card-title:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.5
    use: Feature and gallery headings on the EV6 page (h3), Kia Signature Bold
  model-name:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.43
    use: Model and trim name on Best Kia and recommended-model cards (h4.name), Kia Signature Regular
  tab:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    use: Best Kia tabs on home, Kia Signature Bold (the lineup and EV6 tabs use 20px with a 28.6px line)
  news-title:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.67
    use: News headlines on home, Kia Signature Bold
  body:
    fontSize: 16px
    fontWeight: 400
    use: Page body text, Kia Signature Regular (line height computes normal)
  body-long:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.75
    use: Card specification lines, Kia Signature Regular
  button:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1
    use: Action labels on the square buttons, Kia Signature Bold
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Footer utility links, Kia Signature Regular
  fine:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 2
    use: Footer award notes, Kia Signature Regular
rounded:
  none: 0px
  badge: 15px
  segment: 32px
spacing:
  button-y: 16
  button-x: 24
  link-card: 24
  tab-gap: 40
  badge-x: 17
components:
  primary-button:
    type: button
    backgroundColor: '#05141f'
    textColor: '#ffffff'
    border: '1px solid #05141f'
    rounded: 0px
    padding: 16px 24px
    height: 48px
    typography: 14px / 400 / 14px Kia Signature Bold
    states: rest on 17 captured instances across home and the EV6 page; no hover or pressed frame was recorded for them, and the collector's expansion pass recorded no interaction events, so no state value is declared
    use: Primary square action (바로가기 and 견적 내기 on the home hero slides, 견적 내기 on the EV6 page) at home::[data-omd-capture="13"], 102 x 48
    focus: 'outline #000000 dashed 3px on :focus-visible'
  hero-secondary-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#05141f'
    border: '1px solid #ffffff'
    rounded: 0px
    padding: 16px 24px
    height: 48px
    typography: 14px / 400 / 14px Kia Signature Bold
    states: rest on 12 captured instances; no state frame
    use: White action paired with the dark one over hero imagery (렌터카 견적 내기, 자세히 보기) at home::[data-omd-capture="12"], 149 x 48
  outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#05141f'
    border: '1px solid #9fa5a9'
    rounded: 0px
    padding: 16px 24px
    height: 48px
    typography: 14px / 400 / 14px Kia Signature Bold
    states: rest on 10 captured instances; no state frame
    use: Outlined action on white (Best Kia cards on home, 시승 신청 in the EV6 sub-navigation) at home::[data-omd-capture="47"], 119 x 48
  header-utility-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 23px
    typography: 16px / 400 / 22.88px Kia Signature Regular
    states: 'rest only; the same language, search and sign-in controls read #37434b on the white header of the lineup page (surface-2 captures 9-11), so the header recolours with the page'
    use: Header utility controls (KR, 통합검색, 로그인) over the home and EV6 heroes at home::[data-omd-capture="10"]; styles were read without following the sign-in link
  footer-family-select:
    type: button
    backgroundColor: '#010e18'
    textColor: '#f8f8f8'
    border: '1px solid #010e18'
    rounded: 0px
    padding: 16px 24px
    height: 48px
    typography: 14px / 400 / 20.02px Kia Signature Regular
    states: rest on all three pages; no state frame
    use: Family-site dropdown in the footer at home::[data-omd-capture="85"], 270 x 48
  calculator-select:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#05141f'
    border: '1px solid #ffffff'
    rounded: 0px
    padding: 16px 44px 16px 24px
    height: 57px
    typography: 16px / 400 / 22.88px Kia Signature Bold
    disabled: 'fg #dadbdc (capture 57, disabled at rest)'
    states: enabled rest (capture 58) and a disabled sibling (capture 57); no pointer frame
    use: Dropdown selects in the EV driving-range calculator on the EV6 page at surface-3::[data-omd-capture="58"], 384 x 57
  best-kia-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#697278'
    height: 46px
    typography: 20px / 400 / 32px Kia Signature Bold
    selected: 'fg #05141f on the li.is-on tab (capture 41)'
    states: selected variant read from rest values (capture 41 against 42-44); no pointer frame
    use: Best Kia category tabs on home (최근 출시, 연비 효율, 적재공간, 안전성) at home::[data-omd-capture="42"]
  vehicle-category-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#697279'
    padding: 16px 0px
    height: 56px
    typography: 20px / 400 / 28.6px Kia Signature Bold
    selected: 'fg #05141f on the is-active item (capture 12)'
    states: selected variant read from rest values (capture 12 against 13-16); no pointer frame
    use: Lineup category tabs (EV, PBV, 승용, RV, 택시 & 버스 & 상용) on the vehicles page at surface-2::[data-omd-capture="13"]; items are spaced by 40px right padding
  vehicle-subnav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#697278'
    height: 52px
    typography: 20px / 400 / 28.6px Kia Signature Bold
    selected: 'fg #05141f on the is-active link (capture 15)'
    states: selected variant read from rest values (capture 15 against 16-22); no pointer frame
    use: EV6 sub-navigation (특징, 제원, 갤러리, 모델 비교, 가격, EV TCO 계산기) at surface-3::[data-omd-capture="16"]
  trim-segmented-control:
    type: tab
    backgroundColor: transparent
    textColor: '#05141f'
    border: '1px solid #05141f (track)'
    rounded: 32px
    padding: 6px (track)
    height: 47px
    typography: 16px / 400 / 22.88px Kia Signature Bold
    selected: 'bg #05141f, fg #ffffff (capture 39)'
    states: selected variant read from rest values (capture 39 against 40); no pointer frame
    use: Two-option switch on the EV6 page at surface-3::[data-omd-capture="40"], 130 x 47 per option inside a 278 x 61 track (surface-3::#pdp__tab)
  label-badge:
    type: badge
    backgroundColor: '#f8f8f8'
    textColor: '#05141f'
    rounded: 15px
    padding: 0px 17px
    height: 32px
    typography: 14px / 400 / 14px Kia Signature Regular
    use: Label on recommended-model cards on the EV6 page (p.label-txt), 103 x 32
  best-label-badge:
    type: badge
    backgroundColor: '#05141f'
    textColor: '#ffffff'
    rounded: 15px
    padding: 0px 17px
    height: 32px
    typography: 14px / 400 / 25px Kia Signature Regular
    use: Highlighted variant of the same label (p.label-txt.best), 99 x 32
  quick-link-card:
    type: card
    backgroundColor: '#f8f8f8'
    rounded: 0px
    padding: 24px
    size: 250px x 244px
    use: Grey link panel (a.pdp-link__btn) near the foot of home at home::[data-omd-capture="59"]; the EV6 page repeats it at 432 x 244; its label sits in children that were not captured, so no text colour is claimed
  floating-chat-button:
    type: button
    backgroundColor: '#ffffff'
    rounded: 50%
    size: 56px x 56px
    shadow: rgb(78, 78, 78) 1px 1px 10px 0px
    states: rest; its only pressed frame changes the anchor to the browser's default active red, which is not a brand value, so nothing is declared
    use: 채팅 상담 button beside the hero at home::[data-omd-capture="40"]; lower on the page the same control carries rgba(0, 0, 0, 0.2) 0px 7px 15px 0px
  top-button:
    type: button
    backgroundColor: '#ffffff'
    rounded: 50%
    size: 56px x 56px
    shadow: rgba(0, 0, 0, 0.2) 0px 7px 15px 0px
    states: rest on all three pages; no state frame
    use: Back-to-top button at home::[data-omd-capture="94"]
fonts:
  roles:
    display: Kia Signature Bold
    body: Kia Signature Regular
    light: Kia Signature Light
---

# Kia

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kia; reproduced for educational reference. Full prose: https://oh-my-design.kr/kia/design.md
