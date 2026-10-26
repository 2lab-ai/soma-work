---
name: Greencar
colors:
  primary: '#222222'
  on-primary: '#ffffff'
  accent: '#00c88c'
  ink: '#000000'
  ink-soft: '#171717'
  warm-grey: '#3e3a39'
  body-grey: '#434343'
  muted: '#5e5e5e'
  faint: '#b4b4b4'
  surface: '#f6f6f6'
  hairline: '#dddddd'
  promo-red: '#f83333'
  white: '#ffffff'
typography:
  display-service:
    fontSize: 80px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Service page title on the G car round-trip page (h2.local-name), 120px line, #222222, Outfit stack'
  display:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Closing headline on the G car home (h2.title), 96px line, #171717, Outfit stack'
  headline:
    fontSize: 52px
    fontWeight: 800
    lineHeight: 1.5
    use: 'Feature headlines on the G car home (h3.title), 78px line, #171717; the section h2s run 52px at weight 600'
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Section headings on the corporate home (h3.section-subject, p.para), 54px line, #222222; stack Outfit, Pretendard, so Hangul glyphs render in Pretendard'
  section-service:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Section titles on the G car round-trip page (h3.section-title), Pretendard first, 54px line, #171717'
  wordmark:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Header h1 wordmark on the corporate home, 48px line, #000000'
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Card subjects on the G car round-trip page (p.subject), 36px line, #171717'
  tab:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.5
    use: Service tabs on the G car round-trip page, Pretendard, 36px line
  lead:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.5
    use: Service slide summaries on the corporate home (p.summary), 30px line, white on the slide image
  reading:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Guide bullets revealed by the G car round-trip tabs (li.bullet-item), 30px line, #434343'
  nav:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.2
    use: 'Header navigation on the corporate home (a.gnb-name), 21.6px line, #171717'
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.4
    use: Button labels on the corporate home, 22.4px line, Outfit stack
  badge:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: Coupon and promotion labels on the G car round-trip page, Pretendard, 24px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default on the corporate home, stack Outfit, Pretendard, sans-serif, 24px line, #000000'
  desc:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Service-card descriptions on the G car home (p.desc), Pretendard, 24px line, #5e5e5e'
rounded:
  button: 8px
  badge: 8px
  coupon: 10px
  link: 12px
  tab: 16px
  card: 20px
spacing:
  button-y: 14
  button-x: 20
  card-y: 40
  card-x: 24
  coupon: 18
  badge-y: 4
  badge-x: 12
  link-y: 13
  link-x: 17
components:
  button-fill:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    border: '1px solid #222222'
    rounded: 8px
    padding: 14px 20px
    height: 52px
    typography: 16px / 700 / 22.4px Outfit stack
    hover: 'bg #00c88c, fg #222222, border #00c88c'
    pressed: 'bg #00c88c, fg #222222, border #00c88c'
    states: 'probe: hover and pressed settle on #00c88c with a #222222 label after an 800ms transition; focus paints the same fill but the only ring is the browser default, so no brand focus style is declared'
    use: 채용 바로가기 on the corporate home at home::[data-omd-capture="39"], 128 x 52, sitting on the green recruiting band
    focus: 'bg #00c88c, label #222222, border #00c88c, browser default focus ring (outline auto) (+1 nested-layer changes) on :focus-visible'
  button-line:
    type: button
    backgroundColor: transparent
    textColor: '#222222'
    border: '1px solid #222222'
    rounded: 8px
    padding: 14px 20px
    height: 52px
    typography: 16px / 700 / 22.4px Outfit stack
    hover: 'bg #00c88c, border #00c88c'
    pressed: 'bg #00c88c, border #00c88c'
    states: 'probe: hover and pressed fill #00c88c and turn the border green; the label stays #222222; transition all 0.2s'
    use: 더 많은 뉴스 보기 under the news section of the corporate home at home::[data-omd-capture="12"], 148 x 52
  button-line-invert:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 8px
    padding: 14px 20px
    height: 52px
    typography: 16px / 700 / 22.4px Outfit stack
    states: rest only; the bundle holds a focus frame, which is not declared
    use: 더 알아보기 on the three service slides of the corporate home (G car, 무버스, 세차클링), 324 x 52
  brand-panel:
    type: card
    backgroundColor: '#00c88c'
    size: 1440px x 640px
    use: Full-bleed green recruiting band (div.section-06) on the corporate home, with a repeating noise texture in ::after; read by the probe as the ancestor of 채용 바로가기
  nav-item:
    type: tab
    textColor: '#171717'
    typography: 18px / 500 / 21.6px Outfit stack
    states: rest only; no pointer or keyboard state was read
    use: Header navigation (그린카, 서비스, 인재채용, 뉴스) on the corporate home
  link-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: 1px solid rgba(0, 0, 0, 0.08)
    rounded: 12px
    padding: 13px 17px
    height: 50px
    typography: 16px / 400 Outfit stack
    states: rest only; no pointer or keyboard state was read
    use: Outbound-link buttons (a.btn.module-a with an out-link icon) on the G car home, four instances, 138-158 x 50
  service-card:
    type: card
    backgroundColor: '#f6f6f6'
    border: 1px solid rgba(0, 0, 0, 0.08)
    rounded: 20px
    padding: 40px 24px
    size: 400px x 431px
    use: Six grey service cards on the G car home
  service-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: 1px solid rgba(0, 0, 0, 0.08)
    rounded: 16px
    padding: 18px
    height: 74px
    typography: 24px / 500 / 36px Pretendard
    selected: 'bg #222222, fg #ffffff, border #222222'
    states: selected read after the collector clicked the first tab; no hover, pressed or focus value was read
    use: Tabs on the G car round-trip page; the collector clicked the first and read the selected fill
  coupon-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #dddddd'
    rounded: 10px
    padding: 18px
    shadow: rgba(0, 0, 0, 0.08) 0px 4px 8px 0px
    size: 220px x 136px
    use: Three coupon cards on the G car round-trip page, the only elements with a shadow
  coupon-badge:
    type: badge
    backgroundColor: '#f83333'
    textColor: '#ffffff'
    rounded: 8px
    padding: 4px 12px
    height: 32px
    typography: 16px / 600 / 24px Pretendard
    use: Red coupon and promotion labels (p.coupon-label, p.label) on the G car round-trip page, eight instances
fonts:
  roles:
    display: Outfit
    body: Pretendard
---

# Greencar

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Greencar; reproduced for educational reference. Full prose: https://oh-my-design.kr/greencar/design.md
