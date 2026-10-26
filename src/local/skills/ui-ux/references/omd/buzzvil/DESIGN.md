---
name: Buzzvil
colors:
  primary: '#f44336'
  on-primary: '#ffffff'
  black: '#000000'
  navy: '#0e171f'
  ink-slate: '#1c2b36'
  body: '#2a3f4d'
  secondary: '#3e5463'
  muted: '#5b7282'
  muted-alt: '#7a909e'
  faint: '#9fb1bd'
  surface: '#f2f5f7'
  surface-soft: '#f8f9fa'
  mist: '#dce3e8'
  white: '#ffffff'
typography:
  display-hero:
    fontSize: 78px
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: '-0.78px'
    use: 'Home hero headline (모두가 사랑하는 방식의 광고), 109.2px line; its fill is clipped to the text over the #0e171f hero, so no text colour is a token'
  display-about:
    fontSize: 76px
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: '-0.76px'
    use: Mission headline on /company/about_us (Boost our client growth in a way people love.), white, 106.4px line
  display-product:
    fontSize: 56px
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: '-0.56px'
    use: 'Product page headline on /monetize/buzzbenefit, #000000, 78.4px line'
  stat:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.56px'
    use: Hero statistics on home (39%, x4, 82%), white
  section:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.48px'
    use: 'Section headings on all three pages, white on dark bands and #000000 on light ones, 67.2px line'
  stat-value:
    fontSize: 48px
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: '-0.48px'
    use: Company figures on /company/about_us (9,000만+, 82%, 500개+, 4배)
  subsection:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.36px'
    use: 'Feature headings on home and about (white on dark, #1c2b36 on light), 54px line'
  card-title:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: 'Ad-product card titles on home (노출형 →, SNS형 →), #000000, 44.8px line'
  lead:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.24px'
    use: Hero subline on home, 36px line
  eyebrow:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: 'Red eyebrows over the ad-product cards (압도적인 클릭률) and the product page name (버즈베네핏), in #f44336'
  body-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: 'Card descriptions on home, in #3e5463, 30px line'
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.64
    letterSpacing: '-0.18px'
    use: 'Reading copy on about and the product page, in #2a3f4d, 29.52px line'
  nav:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: '-0.16px'
    use: Header navigation (Products, Technologies, Resources, Company, Career)
  button:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '-0.16px'
    use: Header action labels (광고센터 바로가기, 문의하기)
  button-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: Hero button labels (광고 상품 둘러보기, 광고 문의하기)
  caption:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: '-0.12px'
    use: 'Group labels in the footer, in #9fb1bd, 19.2px line'
rounded:
  cta: 4px
  button: 8px
  feature: 12px
  card: 32px
spacing:
  cta-y: 12
  cta-x: 16
  hero-btn-y: 16
  hero-btn-x: 32
  card: 40
  card-top: 80
components:
  contact-button:
    type: button
    backgroundColor: '#f44336'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 16px
    height: 44px
    typography: 16px / 400 / 25.6px Pretendard, letter-spacing -0.16px
    hover: lifts 4px (transform translateY(-4px)); colours unchanged
    pressed: lifts 4px, as hover
    states: transition all 0.4s ease; focus shows only the browser's default ring, so no brand focus style is declared
    use: 문의하기 with an arrow icon in the fixed header of all three pages (home capture 7, about and product page capture 6)
  adcenter-button:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 16px
    height: 44px
    typography: 16px / 400 / 25.6px Pretendard, letter-spacing -0.16px
    hover: lifts 4px (transform translateY(-4px))
    pressed: lifts 4px, as hover
    states: transition all 0.4s ease; focus shows only the browser's default ring
    use: 광고센터 바로가기 with an arrow icon in the fixed header, linking to the self-serve ad centre
  lang-toggle:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1.17647px solid #000000'
    rounded: 4px
    padding: 12px 16px
    height: 44px
    typography: 16px / 400 Pretendard
    hover: lifts 4px (transform translateY(-4px))
    pressed: lifts 4px, as hover
    states: 'focus (Tab #8) shows no change'
    use: ENG language switch at the end of the header
  nav-item:
    type: tab
    textColor: '#5b7282'
    height: 75px
    typography: 16px / 600 / 25.6px Pretendard, letter-spacing -0.16px
    hover: 'fg #000000'
    pressed: 'fg #000000'
    states: 'hover and pressed settle on #000000 (probe and bundle frames agree); focus (Tab #1) shows no change'
    use: Header navigation buttons (Products, Technologies, Resources, Company, Career), 56 x 75
  explore-button:
    type: button
    backgroundColor: '#f2f5f7'
    textColor: '#3e5463'
    border: '1.17647px solid #f2f5f7'
    rounded: 8px
    padding: 16px 32px
    height: 55px
    typography: 20px / 400 / 30px Pretendard, letter-spacing -0.2px
    hover: filter brightness(0.9)
    pressed: filter brightness(0.9)
    states: transition background-color, color 0.3s ease; focus shows only the browser's default ring
    use: 광고 상품 둘러보기 in the home hero, 204 x 55
  ghost-button:
    type: button
    backgroundColor: transparent
    textColor: '#f2f5f7'
    border: '1.17647px solid #f2f5f7'
    rounded: 8px
    padding: 16px 32px
    height: 55px
    typography: 20px / 400 / 30px Pretendard, letter-spacing -0.2px
    hover: bg rgba(242, 245, 247, 0.125), filter brightness(1.1)
    pressed: bg rgba(242, 245, 247, 0.125), filter brightness(1.1)
    states: transition background-color, color 0.3s ease; focus shows only the browser's default ring
    use: '광고 문의하기 beside the explore button, over the #0e171f hero'
  feature-card:
    type: button
    backgroundColor: '#dce3e8'
    rounded: 12px
    padding: 80px 40px 0px
    size: 500px x 588px
    states: rest on seven captured instances; no state frame, not probed
    use: Large selectable cards lower on /monetize/buzzbenefit (7 instances); their labels were not read
  product-link-card:
    type: card
    rounded: 32px
    padding: 40px
    size: 496px x 153px
    use: '버즈베네핏 → and 버즈부스터 → links on home, each on a white gradient fill (not a token) with a 36px / 700 title and a #7a909e line'
  about-card:
    type: card
    backgroundColor: '#f8f9fa'
    rounded: 8px
    size: 317px x 516px
    use: 'Advertise, Activate and Monetize cards under 브랜드의 성장 단계별 지원 on /company/about_us, with #7a909e labels and #1c2b36 32px titles'
  carousel-arrow:
    type: button
    backgroundColor: transparent
    border: '1.17647px solid #ffffff'
    rounded: 8px
    shadow: rgba(22, 34, 51, 0.12) 0px 4px 12px -4px
    size: 54px x 54px
    disabled: all four instances were disabled at capture
    states: disabled at rest only; no other state read
    use: Carousel arrows on home, two pairs (captures 18-19 at the ad-product carousel, 26-27 lower on the page); the only elements with a shadow
fonts:
  roles:
    sans: Pretendard
---

# Buzzvil

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Buzzvil; reproduced for educational reference. Full prose: https://oh-my-design.kr/buzzvil/design.md
