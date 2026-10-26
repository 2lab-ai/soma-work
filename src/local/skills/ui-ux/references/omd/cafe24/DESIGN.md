---
name: Cafe24
colors:
  primary: '#084fff'
  black: '#000000'
  accent: '#235bf5'
  ink: '#1c1c1c'
  ink-cool: '#1b1e26'
  slate: '#444b59'
  muted: '#757575'
  faint: '#a6a6a6'
  soft: '#bfbfbf'
  charcoal: '#323232'
  canvas: '#ffffff'
  surface: '#f9fafb'
  surface-alt: '#f0f2f3'
  hairline: '#e0e0e0'
  highlight: '#10b981'
typography:
  display-xl:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.25
    use: 'Hero headline of the design service page (쇼핑몰 디자인), Cafe24Ohsquare, computed 55.98px on a 70.02px line, in #1b1e26'
  display:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.21
    use: 'Section titles on home and the enterprise page, Cafe24Ohsquare, 58px line, #1c1c1c on light bands and #ffffff on dark ones'
  banner-title:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: '-0.4px'
    use: 'Banner headline on home (banner__title), Cafe24Ohsquare, 54px line, in #ffffff'
  feature-title:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.53
    use: 'Feature grid titles on home (feature-grid__card-title), Cafe24Ohsquare, 46px line, in #1c1c1c'
  card-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.42
    use: White content card titles on home, Cafe24Ohsquare, 34px line
  card-title-sm:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: Grey content card titles on home, Cafe24Ohsquare, 28px line
  lead:
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Lead paragraphs on the design service page, Pretendard, computed 21.996px on a 32.94px line, in #444b59'
  section-desc:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Section descriptions under home titles, Pretendard, 28px line, in #757575 (white on dark bands)'
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Card and page body on home, Pretendard, 27px line, in #1c1c1c'
  quote:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.56
    use: 'Customer testimonial quotes on home, Pretendard, 28px line, in #ffffff'
  button-lg:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.45
    use: Label of the 64px round call to action on home, 32px line
  button:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.44
    use: Label of the 56px round call to action on home, 26px line
  label:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Promo pill labels on home, 24px line, in #000000'
  description:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Content card descriptions on home, 24px line, in #757575'
  caption:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
    use: Brand names under the brand cards on home, 20px line
  small:
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.38
    use: Result lines on the story cards on home, 18px line
rounded:
  cta-sharp: 3.96px
  icon: 8px
  card: 12px
  card-lg: 16px
  card-xl: 20px
  tab: 30px
  header-pill: 100px
  pill: 9999px
spacing:
  card-y: 40
  card-x: 32
  pill-y: 12
  pill-x: 24
  cta-x: 32
  cta-x-lg: 40
components:
  header-cta:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    border: '1px solid #000000'
    rounded: 100px
    padding: 12px 16px
    height: 40px
    typography: 16px / 700 / 40px Pretendard
    states: rest only on two pages; the Aside bundle has no hover, pressed or focus frame
    use: 쇼핑몰 만들기 in the header of the design service and enterprise pages, 121 x 40, at surface-2::[data-omd-capture="1"] and surface-3::[data-omd-capture="1"]
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  design-cta:
    type: button
    backgroundColor: '#235bf5'
    textColor: '#ffffff'
    border: '1px solid #235bf5'
    rounded: 3.96px
    padding: 0px 39.96px
    height: 56px
    typography: 18px / 700 / 54px Pretendard
    states: rest only; no state frame
    use: 'The in-page 쇼핑몰 만들기 at the foot of the design service page, 179 x 56, at surface-2::[data-omd-capture="17"]; the page''s text links use the same #235bf5'
  round-cta-lg:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1c1c1c'
    rounded: 9999px
    padding: 0px 40px
    height: 64px
    typography: 22px / 700 / 32px Pretendard
    states: rest only; no state frame
    use: White round call to action (btn--fill btn--round btn--on-dark) under a white section title on a dark band of home, 201 x 64, at home::[data-omd-capture="33"]; its label was not recorded
  round-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1c1c1c'
    rounded: 9999px
    padding: 0px 32px
    height: 56px
    typography: 18px / 700 / 26px Pretendard
    states: rest only; no state frame
    use: White round call to action (btn--primary) under the white banner headline on home, 179 x 56, at home::[data-omd-capture="34"]; its label was not recorded
  floating-banner-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 999px
    padding: 0px 24px
    height: 44px
    typography: 15px / 600 / 22.5px Pretendard
    states: rest only; no state frame
    use: Button on the floating banner of the home hero (cafe24pro-hero__floating-banner-btn), 172 x 44, at home::[data-omd-capture="10"]
  enterprise-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#1c1c1c'
    border: '1px solid #ffffff'
    rounded: 30px
    padding: 0px 20px
    height: 50px
    typography: 20px / 700 / 28px Arial (system stack)
    selected: 'bg #1c1c1c, fg #ffffff (class active)'
    states: rest values only; selected read from the active class at rest; no hover, pressed or focus frame
    use: Tab buttons (btnTab) in the enterprise page's tab menu at surface-3::[data-omd-capture="4"]; the menu strip itself carries a 0 0 4px shadow
  link-pill:
    type: button
    backgroundColor: '#f0f2f3'
    textColor: '#1c1c1c'
    border: '1px solid #ffffff'
    rounded: 100px
    padding: 0px 24px
    height: 56px
    typography: 18px / 700 / 54px Pretendard
    states: rest only; no state frame
    use: Grey pill link on the enterprise page, 147 x 56, at surface-3::[data-omd-capture="62"]
  slider-control:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.2)
    textColor: '#ffffff'
    rounded: 9999px
    size: 60px x 60px
    states: rest only on three instances; no state frame
    use: Previous, play and next controls of the brand story carousel on home (pro-brands__ctrl) at home::[data-omd-capture="20"]
  promo-pill:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 9999px
    padding: 12px 24px
    height: 48px
    typography: 16px / 700 / 24px Pretendard
    shadow: rgba(0, 0, 0, 0.04) 0px 2px 8px 0px
    use: 'White benefit pills stacked in the home promo cards (promo-card__pill); a two-line variant is 72px tall and carries a #10b981 highlight span'
  content-card-gray:
    type: card
    backgroundColor: '#f9fafb'
    rounded: 20px
    padding: 40px 32px
    size: 200px x 202px
    use: 'Grey linked cards on home (content-card--gray, six instances), each with a 38px #000000 icon box at 8px radius and a 20px Cafe24Ohsquare title'
  content-card-white:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e0e0e0'
    rounded: 16px
    padding: 40px 32px
    size: 416px x 228px
    use: 'White linked cards on home (content-card--white, three instances) with a 24px title and #757575 description'
  intro-dark-card:
    type: card
    backgroundColor: '#323232'
    rounded: 12px
    shadow: rgba(0, 0, 0, 0.43) 0px 20.57px 51.43px 0px on the active card; rgba(0, 0, 0, 0.07) 0px 3.43px 8.57px 0px on its neighbours; none on the far cards
    use: Fanned carousel cards in the dark intro section of home (intro-section-dark__card), 406–578px wide
  story-card:
    type: card
    backgroundColor: '#323232'
    rounded: 16px
    size: 560px x 560px
    use: 'Square image cards of the customer story section on home (story-section__card-img); #323232 is the placeholder fill under the photograph'
fonts:
  roles:
    display: Cafe24Ohsquare
    body: Pretendard
---

# Cafe24

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cafe24; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/cafe24/DESIGN.md
