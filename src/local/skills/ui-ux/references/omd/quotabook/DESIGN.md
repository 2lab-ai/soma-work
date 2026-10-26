---
name: Quotabook
colors:
  primary: '#00e8c5'
  on-primary: '#171b21'
  canvas: '#000000'
  white: '#ffffff'
  heading-soft: '#e6e6e6'
  band-mint: '#04e8c6'
  mint-text: '#96faeb'
  nav-grey: '#979797'
  muted: '#8e8e94'
  muted-light: '#bfbfbf'
  footer-grey: '#828282'
  surface-dark: '#121212'
  text-dark: '#333333'
typography:
  mega:
    fontSize: 180px
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: '-8.4px'
    use: Home hero word 금융, Pretendard ExtraBold, white, 189px line; the hero lines above it share the size at -9px tracking
  product-hero:
    fontSize: 140px
    fontWeight: 900
    lineHeight: 1
    letterSpacing: '-3px'
    use: Hero headline of /platform/stock-award, Pretendard Black, white, 140px line
  pricing-hero:
    fontSize: 130px
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: '-3px'
    use: Pricing headline, Pretendard Black, white, 143px line
  display:
    fontSize: 100px
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: '-3.5px'
    use: 'Section heading 쿼타북 BizSuite on home, Pretendard Black, #e6e6e6, 105px line'
  display-md:
    fontSize: 90px
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: '-3.5px'
    use: 'Section heading 기업 맞춤형 End-to-End 서비스 on home, Pretendard Black, #e6e6e6, 94.5px line'
  section:
    fontSize: 80px
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: '-3.2px'
    use: 'Section headings on /pricing, Pretendard Black, #e6e6e6, 92px line'
  closing:
    fontSize: 79px
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: '-3.2px'
    use: 'Closing-band headline on home, Pretendard Black, #000000 on the mint band, 90.85px line'
  feature:
    fontSize: 59px
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: '-2px'
    use: 'Large feature labels on home, Pretendard Black, #e6e6e6, 67.85px line'
  card-title:
    fontSize: 25px
    fontWeight: 800
    lineHeight: 1.35
    letterSpacing: '-0.8px'
    use: 'Card headings on /platform/stock-award, Pretendard ExtraBold, #333333, 33.75px line'
  lead:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: '-0.5px'
    use: 'Descriptions on home, Pretendard Medium, #8e8e94, 25.2px line'
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.15px'
    use: Action labels 바로 결제 and 견적 문의, Pretendard Bold, 16px line
  nav:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.1px'
    use: 'Header navigation labels, Pretendard Bold, #979797'
  chip:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.15px'
    use: 'Category chip labels, Pretendard Bold, #171b21'
  login:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.15px'
    use: 'Header 로그인 label, Pretendard Bold, #171b21'
  legal:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 0.93
    use: 'Footer company disclosure, Pretendard Medium, #828282, 13px line'
rounded:
  pill: 50px
  chip: 30px
  social: 3px
spacing:
  cta-y: 15
  cta-x: 16
  chip-y: 12
  chip-x: 15
  social-y: 10
  social-x: 12
components:
  pay-button:
    type: button
    backgroundColor: '#00e8c5'
    textColor: '#171b21'
    rounded: 50px
    padding: 15px 16px
    height: 46px
    typography: 16px / 700 / 16px Pretendard Bold (label), letter-spacing -0.15px
    states: 'probe on home: hover shows no change across the button, its 3 descendants and 3 ancestor levels; pressed changes only Chromium''s default link colour on the anchor and its wrappers, not the visible label; focus draws only the browser''s default ring; transition all 0s; no brand state is declared'
    use: 바로 결제 in the home hero at home::[data-omd-capture="6"], 90.3 x 46, linking to the app checkout; the same mint pill opens /platform/stock-award
  plan-button:
    type: button
    backgroundColor: '#00e8c5'
    rounded: 50px
    padding: 12px 14px
    height: 39px
    states: 'rest only: the bundle''s hover and focus frames show no change on the anchor and its pressed frame only the default link colour; the label child was not recorded, so no label value or state is declared'
    use: 바로 결제 and 견적 문의 on the plan cards of /pricing at surface-2::[data-omd-capture="5"] (16 instances, 83 x 39)
  quote-ghost-button:
    type: button
    backgroundColor: transparent
    textColor: '#96faeb'
    rounded: 50px
    padding: 15px 16px
    height: 46px
    typography: 16px / 700 Pretendard Bold (label)
    states: 'probe on home: hover no change; pressed only the default link colour; focus only the browser ring; transition all 0s'
    use: 견적 문의 beside 바로 결제 in the home hero, a borderless pill over the black canvas, 90.3 x 46, read by the fixed probe
  login-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171b21'
    rounded: 50px
    padding: 14px 16px
    height: 42px
    typography: 14px / 700 / 14px Pretendard Bold (label), letter-spacing -0.15px
    states: 'probe on home: hover no change; pressed only the default link colour; focus only the browser ring'
    use: 로그인 in the header of all three pages at home::[data-omd-capture="5"], 67.9 x 42, linking to the app login
  category-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171b21'
    rounded: 30px
    padding: 12px 15px
    height: 39px
    typography: 15px / 700 / 15px Pretendard Bold (label), letter-spacing -0.15px
    states: 'probe on home: hover no change; pressed only the default link colour; focus only the browser ring'
    use: 디지털 플랫폼 chips on the BizSuite cards of home at home::[data-omd-capture="8"], 110.2 x 39, linking to the platform pages
  closing-pay-button:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 50px
    padding: 14px 16px
    height: 44px
    typography: 16px / 700 / 16px Pretendard Bold (label)
    states: 'probe on home: hover no change; pressed only the default link colour; focus only the browser ring'
    use: '바로 결제 on the mint closing band of home at home::[data-omd-capture="13"], 90.3 x 44; the band is #04e8c6'
  closing-quote-button:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.95)
    textColor: '#000000'
    rounded: 50px
    padding: 15px 16px
    height: 46px
    typography: 16px / 800 / 16px Pretendard ExtraBold (label)
    states: 'probe on home: hover no change; pressed only the default link colour; focus only the browser ring'
    use: 견적 문의 beside the black 바로 결제 on the closing band at home::[data-omd-capture="14"], 90.2 x 46
  social-button:
    type: button
    backgroundColor: '#121212'
    rounded: 3px
    padding: 10px 12px
    height: 34px
    states: rest only; not probed
    use: 링크드인, 네이버 블로그 and 브런치 스토리 in the footer of all three pages at home::[data-omd-capture="30"] (72 to 98 wide, 34 tall); the label sits in a child the collector did not record, so no label colour is declared
fonts:
  roles:
    display: Pretendard
---

# Quotabook

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Quotabook; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/quotabook/DESIGN.md
