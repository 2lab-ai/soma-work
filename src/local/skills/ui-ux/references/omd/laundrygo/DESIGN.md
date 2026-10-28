---
name: LaundryGo
colors:
  primary: '#0ac290'
  primary-hover: '#13ab82'
  on-primary: '#ffffff'
  ink: '#000000'
  canvas: '#ffffff'
  ink-soft: '#3a3a3a'
  title: '#212121'
  heading-alt: '#212529'
  muted: '#60646a'
  neutral-fill: '#dfdfdf'
  footer: '#888c8e'
  faint: '#b5bcc0'
  pagination-off: '#c9c9c9'
  mint-tint: '#dbf5ee'
typography:
  display-hero:
    fontSize: 62px
    fontWeight: 600
    lineHeight: 1.3
    use: Hero headlines on home (의식주 생활의 혁신을 만들어 갑니다.) and the culture page, 80.6px line, white over the hero image
  business-hero:
    fontSize: 49px
    fontWeight: 600
    lineHeight: 1.45
    use: Business page hero (국내 최대 호텔 전문 세탁 서비스, 런드리고 호텔&비즈니스), 71px line, white
  section:
    fontSize: 45px
    fontWeight: 600
    lineHeight: 1.44
    use: 'Section statements under each eyebrow, 65px line, #000000 on white or #ffffff on image bands'
  card-title:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.2
    use: Quality card titles on /business/, 45.6px line
  statement:
    fontSize: 35px
    fontWeight: 700
    lineHeight: 1.2
    use: Vision statements on home and infrastructure headings on /business/, 42px line
  recruit-title:
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.57
    use: 'Recruiting banner headline on home and the culture page, 47px line, in #212121'
  card-description:
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Quality card descriptions on /business/, 39px line, in #60646a'
  feature:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.67
    use: Service names in Our Business on home (런드리고, 런드리24), 40px line
  stat-label:
    fontSize: 23px
    fontWeight: 700
    lineHeight: 1.2
    use: Growth metric labels on home (회원 수, 누적 세탁량), 27.6px line, white
  eyebrow:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.3
    use: 'English section eyebrows (Vision, Our Business, Infra, Quality) in #0ac290, 23.4px line'
  nav:
    fontSize: 17px
    fontWeight: 500
    lineHeight: 1.41
    use: 'Top navigation links, 24px line, in #000000'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Document default on all three pages, 22.4px line, in #000000'
  footer:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 2
    use: 'Footer service and contact links, 30px line, in #888c8e'
  legal:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.86
    use: 'Footer company and legal lines, 26px line, in #b5bcc0'
rounded:
  toggle: 2px
  button: 10px
  quote-card: 10px
  floating: 14px
  card: 33px
spacing:
  nav-gap: 72
  cta-x: 40
  neutral-y: 15
  neutral-x: 30
  card-y: 80
  card-x: 50
  quote: 30
components:
  recruit-button:
    type: button
    backgroundColor: '#0ac290'
    textColor: '#ffffff'
    rounded: 10px
    padding: 0px 40px 0px 37px
    height: 52px
    typography: 17px / 700 / 52px Pretendard
    hover: 'bg #13ab82'
    pressed: 'bg #13ab82'
    states: 'probe on home: hover and pressed settle on #13ab82, read 900ms after a 0.2s linear transition; focus turns the label #3a3a3a and draws a 1px dotted outline in the same colour, the WordPress theme''s generic link focus rule rather than a brand focus style'
    use: 채용공고 보러가기 on the recruiting banner of home and the culture page, 198.5 x 52
  floating-cta:
    type: button
    backgroundColor: '#0ac290'
    textColor: '#ffffff'
    rounded: 14px
    height: 76px
    typography: 24px / 700 / 76px Pretendard
    shadow: rgba(0, 0, 0, 0.15) 0px 14px 29px 0px
    hover: 'bg #13ab82'
    pressed: 'bg #13ab82'
    states: 'probe on /business/ with fixed overlays hidden: hover and pressed settle on #13ab82; on home the fixed header covered it, and Tab never reached it on either page, so focus is unmeasured'
    use: 'Fixed call-to-action at the same spot on all three pages, 256 x 76: B2B·대량세탁 문의 on home, 상담 문의하기 on /business/; the third instance on /culture/ was not probed'
    padding: 0px
    focus: 'label #3a3a3a, outline #3a3a3a dotted 1px on :focus-visible'
  inquiry-button:
    type: button
    backgroundColor: '#0ac290'
    textColor: '#ffffff'
    rounded: 10px
    height: 85px
    typography: 30px / 700 / 85px Pretendard
    hover: 'bg #13ab82'
    pressed: 'bg #13ab82'
    states: 'probe on /business/: hover and pressed settle on #13ab82; focus draws a 1px dotted white outline (theme default)'
    use: 문의하기 under 호텔&비즈니스 상담 at the foot of the business page, 325 x 85
  neutral-button:
    type: button
    backgroundColor: '#dfdfdf'
    textColor: '#60646a'
    rounded: 10px
    padding: 15px 30px
    height: 52px
    typography: 17px / 500 / 22px Pretendard
    hover: 'bg #0ac290, fg #ffffff'
    pressed: 'bg #0ac290, fg #ffffff'
    states: 'probe on home: hover and pressed switch to the brand green with a white label after a 0.3s ease transition; focus draws a 1px dotted #60646a outline (theme default)'
    use: 웹사이트 links under 런드리24 and 런드리고 호텔&비즈니스 in Our Business on home, 140 x 52
  nav-link:
    type: tab
    textColor: '#000000'
    padding: 0px 72px 0px 0px
    typography: 17px / 500 / 24px Pretendard
    states: 'probe on 회사소개: hover and pressed show no change across the link, its four descendants and three ancestor levels; focus draws a 1px dotted #000000 outline (theme default); no active or selected colour was observed'
    use: Top navigation (회사소개, 비즈니스, 컬쳐, 채용 and the rest) on all three pages
  card-toggle:
    type: button
    textColor: '#ffffff'
    rounded: 2px
    size: 55px x 55px
    states: 'probe on /business/: hover, pressed and focus show no change across the button, its label and three ancestor levels'
    use: + toggle that opens the detail of each Quality card on /business/
  quality-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 33px
    padding: 80px 50px
    size: 524px x 498px
    use: 'Four Quality cards on /business/ (지속적인 품질 관리, 고객별 관리 시스템, 고객이 원하는 시간 배송, 배송 시까지 깨끗하게), each with a 38px / 700 title and a 26px / 500 description in #60646a'
  testimonial-card:
    type: card
    backgroundColor: '#dbf5ee'
    rounded: 10px
    padding: 30px 27px 0px 30px
    size: 317px x 235px
    use: Mint employee-quote cards in the Values carousel of the culture page (7 instances); the quote text sits in children the collector did not record, so no text colour is declared
fonts:
  roles:
    body: Pretendard
---

# LaundryGo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to LaundryGo; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/laundrygo/DESIGN.md
