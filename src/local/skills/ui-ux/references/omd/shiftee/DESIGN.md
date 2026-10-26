---
name: Shiftee
colors:
  primary: '#004dc1'
  on-primary: '#ffffff'
  primary-hover: '#0a2864'
  primary-pressed: '#0062cc'
  canvas: '#ffffff'
  ink: '#212529'
  heading: '#1e1f21'
  body-muted: '#464a52'
  on-dark: '#e7ecf7'
  muted: '#969faa'
  caption: '#54595f'
  charcoal: '#35343c'
  charcoal-hover: '#494a4e'
  surface: '#f4f7fb'
  band-blue: '#074499'
  soft-blue: '#dcedfd'
  soft-blue-hover: '#badbfa'
  divider: '#c2cad5'
  tag-blue: '#0575e6'
  hairline: '#ced4da'
  input-text: '#495057'
typography:
  display-hero:
    fontSize: 58px
    fontWeight: 700
    lineHeight: 1.36
    letterSpacing: '-0.4px'
    use: Home hero headline (기업의 도약을 위한 솔루션, Shiftee), white, 78.88px line
  page-title:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.36
    letterSpacing: '-0.4px'
    use: Page headlines on /ko/pricing (#1e1f21) and /ko/company (white over its hero), 70.72px line
  closing:
    fontSize: 46px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: '-0.4px'
    use: Closing-band headline on home, white, 59.8px line
  section:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: '-0.4px'
    use: 'Section headings on all three pages, #1e1f21 (white on dark bands), 52px line'
  price:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: '-0.4px'
    use: Plan prices on /ko/pricing, 46.8px line
  stat:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.65
    letterSpacing: '-0.24px'
    use: Statistic figures on home, 66px line
  subsection:
    fontSize: 32px
    fontWeight: 700
    letterSpacing: '-0.4px'
    use: Feature headings on home, /ko/pricing and /ko/company; line height computes normal
  card-title:
    fontSize: 24px
    fontWeight: 700
    letterSpacing: '-0.4px'
    use: Plan names on /ko/pricing; line height computes normal
  lead:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: '-0.24px'
    use: Hero sublines on home and /ko/company, white, 35px line
  faq-title:
    fontSize: 17px
    fontWeight: 700
    letterSpacing: '-0.4px'
    use: FAQ panel titles on /ko/pricing; line height computes normal
  reading:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: '-0.24px'
    use: 'Feature descriptions on home in #464a52, 26.25px line'
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.24px'
    use: 'Document default, #212529 on #ffffff, 22.5px line'
  tag:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.65
    letterSpacing: '-0.24px'
    use: Eyebrow labels above section headings (sft-tag), 23.1px line
  nav:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 2.57
    letterSpacing: '-0.24px'
    use: Header navigation items, 36px line
  button:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-0.24px'
    use: Header and plan button labels, 14px line
  button-lg:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-0.24px'
    use: Large button labels (자세히 알아보기, 도입 문의하기, 무료 체험), 15px line
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: '-0.24px'
    use: 'Plan notes on /ko/pricing in #54595f, 21.45px line'
  footer-heading:
    fontSize: 12px
    fontWeight: 700
    letterSpacing: '-0.4px'
    use: Footer column headings; line height computes normal
rounded:
  square: 0px
  button-lg: 2px
  button: 3.2px
  input: 4px
  tag: 4px
  expander: 5px
  card: 8px
spacing:
  button-y: 14
  button-x: 25.2
  button-lg-y: 15
  button-lg-x: 45
  card-y: 26
  card-x: 24
  input-y: 6
  input-x: 12
components:
  primary-button:
    type: button
    backgroundColor: '#004dc1'
    textColor: '#ffffff'
    border: '1px solid #004dc1'
    rounded: 3.2px
    padding: 14px 25.2px
    height: 44px
    typography: 14px / 600 / 14px Inter, letter-spacing -0.24px
    hover: 'bg #0a2864, border #0a2864'
    pressed: 'bg #0062cc, border #005cbf, ring rgba(38, 143, 255, 0.5) 0px 0px 0px 3.2px'
    focus: 'bg #0a2864 with the same 3.2px ring (Tab #17 on /ko/pricing)'
    states: 'probe on /ko/pricing: hover settles on #0a2864, pressed on #0062cc with a 3.2px blue ring, focus on #0a2864 with the ring; transition all 0.35s ease-in-out; the plan 문의하기 buttons read the same'
    use: 무료 체험 in the header of /ko/pricing and /ko/company at surface-2::[data-omd-capture="11"] (106 x 44) and the plan actions 문의하기 on /ko/pricing (251 x 44)
  primary-button-lg:
    type: button
    backgroundColor: '#004dc1'
    textColor: '#ffffff'
    border: '1px solid #004dc1'
    rounded: 2px
    padding: 15px 45px
    height: 47px
    typography: 15px / 600 / 15px Inter, letter-spacing -0.24px
    hover: 'bg #0a2864, border #0a2864, translateY(-2px)'
    pressed: 'bg #0062cc, border #005cbf, ring rgba(38, 143, 255, 0.5) 0px 0px 0px 3.2px, translateY(-2px)'
    focus: 'bg #0a2864, the 3.2px ring and the 2px lift (Tab #46)'
    states: 'probe on home: hover lifts 2px and fills #0a2864; pressed fills #0062cc with the ring; transition all 0.35s ease-in-out'
    use: 자세히 알아보기 on home at home::[data-omd-capture="50"], 190.5 x 47
  square-button:
    type: button
    backgroundColor: '#004dc1'
    textColor: '#ffffff'
    border: '1px solid #004dc1'
    rounded: 0px
    padding: 15px 45px
    height: 47px
    typography: 15px / 600 / 15px Inter, letter-spacing -0.24px
    states: 'rest only: the capture''s pressed and focus frames were still moving and the probe did not target this control, so no state value is declared'
    use: 뉴스룸 보기 under the press cards on /ko/company at surface-3::[data-omd-capture="18"], 163 x 47
  login-button:
    type: button
    backgroundColor: transparent
    textColor: '#004dc1'
    border: '1px solid #004dc1'
    rounded: 3.2px
    padding: 14px 25.2px
    height: 44px
    typography: 14px / 600 / 14px Inter, letter-spacing -0.24px
    hover: 'bg #004dc1, fg #ffffff'
    pressed: 'bg #004dc1, fg #ffffff'
    focus: 'bg #004dc1, fg #ffffff (Tab #16)'
    states: 'probe on /ko/pricing: hover, pressed and focus fill the button #004dc1 with a white label'
    use: 로그인 in the header of /ko/pricing and /ko/company at surface-2::[data-omd-capture="10"], 90 x 44; over the home hero it is white with a rgba(255, 255, 255, 0.4) border
  contact-link:
    type: button
    textColor: '#1e1f21'
    rounded: 3.2px
    padding: 14px 25.2px
    height: 49px
    typography: 14px / 500 / 21px Inter, letter-spacing -0.24px
    hover: 'fg #004dc1, underline'
    pressed: 'fg #004dc1, underline'
    focus: 'fg #0a2864 (Tab #15)'
    states: 'probe on /ko/pricing: hover and pressed turn the label #004dc1 and underline it; focus turns it #0a2864; transition all 0.3s ease'
    use: '도입문의 text action in the header of /ko/pricing and /ko/company at surface-2::[data-omd-capture="9"], 121 x 49, with a #004dc1 icon'
  hero-contact-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#004dc1'
    border: '1px solid #ffffff'
    rounded: 3.2px
    padding: 16px 28.8px
    height: 50px
    typography: 16px / 600 / 16px Inter, letter-spacing -0.24px
    hover: opacity 0.95 -> 1
    pressed: opacity 0.95 -> 1
    focus: 'opacity 1 (Tab #18)'
    states: 'probe on home: the button rests at opacity 0.95 and goes fully opaque on hover, pressed and focus; transition all 0.35s ease-in-out'
    use: 도입문의 in the home hero at home::[data-omd-capture="12"], 117.5 x 50
  hero-ghost-button:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.2)
    textColor: '#ffffff'
    border: 1px solid rgba(255, 255, 255, 0.2)
    rounded: 3.2px
    padding: 14px 25.2px
    height: 44px
    typography: 14px / 600 / 14px Inter, letter-spacing -0.24px
    hover: 'bg #ffffff, fg #004dc1, border 1px solid #ffffff'
    pressed: 'bg #ffffff, fg #004dc1, ring rgba(38, 143, 255, 0.5) 0px 0px 0px 3.2px'
    focus: 'bg #ffffff, fg #004dc1 and the ring (Tab #17)'
    states: 'probe on home: the translucent header action turns solid white with a #004dc1 label'
    use: 무료 체험 in the header while it sits over the home hero, at home::[data-omd-capture="11"], 106 x 44
  closing-contact-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#004dc1'
    border: '1px solid #ffffff'
    rounded: 2px
    padding: 15px 45px
    height: 47px
    typography: 15px / 600 / 15px Inter, letter-spacing -0.24px
    hover: translateY(-2px)
    pressed: translateY(-2px)
    focus: 'translateY(-2px) (Tab #49)'
    states: 'probe on home: a 2px lift on hover, pressed and focus, no colour change'
    use: 도입 문의하기 in the closing band of home at home::[data-omd-capture="52"], 176.9 x 47
  closing-trial-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 2px
    padding: 15px 45px
    height: 47px
    typography: 15px / 600 / 15px Inter, letter-spacing -0.24px
    shadow: rgba(54, 55, 61, 0.25) 0px 8px 24px 0px
    hover: 'bg #ffffff, fg #004dc1, translateY(-2px)'
    pressed: 'bg #ffffff, fg #004dc1, translateY(-2px)'
    focus: 'bg #ffffff, fg #004dc1, translateY(-2px) (Tab #50)'
    states: 'probe on home: the outlined action fills white with a #004dc1 label and lifts 2px'
    use: '무료 체험 beside 도입 문의하기 in the closing band of home at home::[data-omd-capture="53"], 160.6 x 47, over the band''s #074499'
  addon-button:
    type: button
    backgroundColor: '#35343c'
    textColor: '#ffffff'
    border: '1px solid #35343c'
    rounded: 3.2px
    padding: 14px 25.2px
    height: 44px
    typography: 14px / 600 / 14px Inter, letter-spacing -0.24px
    hover: 'bg #494a4e, border #494a4e'
    pressed: 'bg #494a4e, ring rgba(38, 143, 255, 0.5) 0px 0px 0px 3.2px'
    focus: 'ring rgba(38, 143, 255, 0.5) 0px 0px 0px 3.2px only (Tab #22)'
    states: 'probe on /ko/pricing: hover and pressed settle on #494a4e; focus adds only the blue ring'
    use: '문의하기 on the add-on plan card (부가서비스 추가) of /ko/pricing at surface-2::[data-omd-capture="15"], 236 x 44; the card itself is #f4f7fb'
  features-expander:
    type: button
    backgroundColor: '#dcedfd'
    textColor: '#004dc1'
    border: '0px top, 1px solid #c2cad5 on the other sides'
    rounded: 0px 0px 5px 5px
    padding: 16px
    height: 57px
    typography: 16px / 700 / 24px Inter, letter-spacing -0.24px
    hover: 'bg #badbfa, fg #0a2864, underline'
    pressed: 'bg #badbfa, fg #0a2864, underline'
    focus: 'fg #0a2864 (Tab #23)'
    states: 'probe on /ko/pricing: hover and pressed fill #badbfa, turn the label #0a2864 and rotate its arrow icon; transition all 0.3s ease'
    use: 모든 기능 보기 under the plan cards of /ko/pricing at surface-2::[data-omd-capture="16"], 1170 x 57
  email-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#495057'
    border: '1px solid #ced4da'
    rounded: 4px 0px 0px 4px
    padding: 6px 12px
    height: 38px
    typography: 16px / 400 / 24px Inter
    states: rest only; the field was not probed and nothing was typed
    use: 'Email field of the free-trial form near the foot of /ko/pricing at surface-2::[data-omd-capture="45"], 391 x 38, joined on its right to a 105 x 38 #004dc1 무료 체험 button'
  plan-tag:
    type: badge
    backgroundColor: '#0575e6'
    textColor: '#ffffff'
    rounded: 4px 4px 0px 0px
    padding: 6px
    height: 33px
    typography: 13px / 700 / 21.45px Inter
    use: Tag across the top of the highlighted plan card on /ko/pricing (sft-standard-tag), 300 x 33
  stat-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 26px 24px
    size: 350px x 259px
    use: Three statistics cards (sft-statistics-card) on /ko/company, flat, no shadow
fonts:
  roles:
    sans: Inter
    hangul: Noto Sans KR
---

# Shiftee

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Shiftee; reproduced for educational reference. Full prose: https://oh-my-design.kr/shiftee/design.md
