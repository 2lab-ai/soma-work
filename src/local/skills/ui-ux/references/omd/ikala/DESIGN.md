---
name: iKala
colors:
  primary: '#061232'
  white: '#ffffff'
  action-blue: '#2563eb'
  nexus-blue: '#3b81db'
  timeline-blue: '#1677ff'
  arrow-blue: '#005cec'
  link: '#3a82dd'
  footer-blue: '#4770df'
  tab-selected: '#2a415e'
  tab-idle: '#95a2b2'
  heading: '#333333'
  body: '#525151'
  black: '#000000'
  field-border: '#cccccc'
  hairline: '#dbdbdb'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-2.99px'
    use: Hero headline on home (Data → Intelligence → Impact) and /zh-tw/ (數據 → 智慧 → 決策), 100.8px line, white over the hero image
  nexus-title:
    fontSize: 60px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0.5px
    use: 'iKala Nexus hero title, 78px line, #333333'
  section:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-1.5px'
    use: 'Section headings on home and /zh-tw/, 50.4px line, #333333 (white on dark bands)'
  section-nexus:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-1.5px'
    use: Section headings on iKala Nexus, 36px line
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-1px'
    use: Data-science cards on home (DataOps, MLOps, Predictive Analytics), 33.6px line
  industry-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-1px'
    use: Industry card titles on home (Manufacturing, Retail & Marketing, Medical, Finance), 24px line
  case-name:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0.3px
    use: Customer names in the iKala Nexus case carousel, 33.6px line
  footer-heading:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: '-0.83px'
    use: Footer column headings (About, Solutions), 25px line, white
  body:
    fontSize: 18px
    fontWeight: 400
    letterSpacing: '-0.27px'
    use: 'Page default on all three pages, line-height normal, #525151'
  nav:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.5px'
    use: 'Header navigation links, 27px line, #333333'
  news-title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.75px'
    use: News and insight card titles, 25.2px line
  button:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1
    use: Hero and news button labels in Noto Sans, 18px line
  tab:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: 0.53px
    use: iKala Nexus solution tabs, 20px line, white
  label:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.48
    use: News / Insight pills, 17.7px line, white
rounded:
  field: 2px
  button: 8px
  label: 30px
  arrow: 50px
spacing:
  cta-y: 20
  cta-x: 30
  button-y: 16
  button-x: 24
  tab-y: 8
  tab-x: 16
  accordion: 20
  label-y: 3
  label-x: 10
components:
  hero-cta:
    type: button
    backgroundColor: '#061232'
    textColor: '#ffffff'
    rounded: 8px
    padding: 20px 30px
    height: 58px
    typography: 18px / 500 / 18px Noto Sans
    states: rest only; no state frame was captured and no probe was run, so no hover, pressed or focus value is declared
    use: Get in Touch on the home hero at home::[data-omd-capture="18"] (167 x 58) and 聯絡我們 on /zh-tw/ (132 x 58)
    pressed: text-decoration underline (+2 nested-layer changes) (:hover + :active)
  blue-button:
    type: button
    backgroundColor: '#2563eb'
    textColor: '#ffffff'
    rounded: 8px
    padding: 16px 24px
    height: 50px
    typography: 18px / 500 / 18px Noto Sans
    states: rest only; no state frame
    use: Read More Articles / 閱讀更多文章 under the news list on home and /zh-tw/
  white-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#2563eb'
    rounded: 8px
    padding: 16px 24px
    height: 50px
    typography: 18px / 500 / 18px Noto Sans
    shadow: rgba(0, 0, 0, 0.19) 0px 0px 10px 0px
    states: rest only; no state frame
    use: View More News / 查看更多新聞 beside the blue button
  nexus-hero-button:
    type: button
    backgroundColor: '#3b81db'
    textColor: '#ffffff'
    rounded: 0px
    padding: 20px 40px
    height: 60px
    typography: 20px / 700 / 20px Noto Sans
    states: rest only; no state frame
    use: Contact Us on the iKala Nexus hero, 188 x 60
  timeline-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1677ff'
    rounded: 8px
    padding: 12px 24px
    height: 38px
    typography: 14px / 700 / 14px Noto Sans
    states: rest only; no state frame
    use: 1st Month, 2nd Month, 3rd Month, Go Live in the iKala Nexus four-step section, 216 x 38
  carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#005cec'
    rounded: 50px
    size: 44px x 44px
    shadow: rgba(135, 158, 180, 0.7) 0px 6px 25px 0px
    disabled: the previous arrow (capture 43) is disabled at rest and computes the same values
    states: rest and disabled only; no pointer frame
    use: Next and previous arrows of the iKala Nexus case carousel
  form-submit:
    type: button
    backgroundColor: '#3b81db'
    textColor: '#ffffff'
    rounded: 2px
    padding: 10px
    height: 40px
    typography: 14px / 500 / 20.3px Noto Sans TC
    states: rest only; no state frame
    use: Submit on the iKala Nexus contact form, 100 x 40
  solution-tab:
    type: tab
    backgroundColor: '#95a2b2'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 16px
    height: 50px
    typography: 16px / 600 / 20px Noto Sans TC, letter-spacing 0.53px
    selected: 'bg #2a415e (Answer FAQs, capture 19)'
    states: selected variant read from rest values; no pointer frame
    use: Seven use-case tabs on iKala Nexus, 362 x 50
  faq-accordion-row:
    type: tab
    border: 1px solid rgba(0, 0, 0, 0.02)
    padding: 20px
    height: 60px
    states: rest only; no state frame
    use: Getting-started questions on home and /zh-tw/ and the iKala Nexus FAQ, 940 x 60; the question text sits in a child element the capture did not record, so no label colour or font is declared
  nav-link:
    type: tab
    textColor: '#333333'
    padding: 0px 20px 0px 0px
    typography: 18px / 400 / 27px Noto Sans TC, letter-spacing -0.5px
    selected: '2px solid #000000 bottom border on the current section menu item (Solutions on iKala Nexus)'
    states: selected variant read from rest values; no pointer frame
    use: Header navigation (Solutions, AI Technology, Blog, About) in the white fixed header
  text-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#525151'
    border: '1px solid #cccccc'
    rounded: 2px
    padding: 9px
    height: 41px
    typography: 16px / 400 / 20.8px Noto Sans TC, letter-spacing -0.24px
    states: rest only
    use: Contact form fields on iKala Nexus, 255 x 41 and 540 x 41
  news-label:
    type: badge
    backgroundColor: rgba(0, 0, 0, 0.7)
    textColor: '#ffffff'
    rounded: 30px
    padding: 3px 10px
    height: 24px
    typography: 12px / 400 / 17.7px Noto Sans TC
    use: News / Insight (新聞 / 洞察) labels over news card images on home and /zh-tw/
fonts:
  roles:
    body: Noto Sans TC
    button: Noto Sans
---

# iKala

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to iKala; reproduced for educational reference. Full prose: https://oh-my-design.kr/ikala/design.md
