---
name: Sandoll
colors:
  primary: '#ff0600'
  on-primary: '#ffffff'
  ink: '#1c1c1c'
  graphite: '#333333'
  footer-ink: '#3b3b3b'
  canvas: '#ffffff'
  hairline: '#eeeeee'
  cloud-action: '#4173fa'
  cloud-action-hover: '#345cc8'
  cloud-surface: '#ebf0ff'
  cloud-hairline: '#dddddd'
  muted: '#999999'
typography:
  display:
    fontSize: 44px
    fontWeight: 400
    lineHeight: 1.34
    use: 'Page title on /story (스토리), SDGretaSans-hBd, the heavy cut is drawn into the face while font-weight computes 400; 58.96px line, in #1c1c1c'
  section:
    fontSize: 34px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Section headings on the corporate home (서비스, 스토리 and the inquiry block), SDGretaSans-hBd, 47.6px line, in #1c1c1c'
  lead:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.8
    use: 'Large statement paragraphs on the corporate home, SDGretaSans-eRg, 43.2px line, in #333333'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.8
    use: Corporate body copy and card text, SDGretaSans-eRg, 28.8px line; the dark footer band sets the same size on a 32px line in white
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.8
    use: Corporate header navigation labels, SDGretaSans-eRg, 28.8px line
  button:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.43
    use: 제작문의 action label, SDGretaSans-eRg, 22.86px line
  button-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: 1px
    use: 포트폴리오 hero action label, SDGretaSans-eRg, 20px line, letter-spacing 1px
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.8
    use: 'Corporate footer company line, SDGretaSans-eRg, 21.6px line, in #3b3b3b'
  cloud-title:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.45
    use: Section titles on sandollcloud.com, SandollGothicNeo1Unicode, 37.7px line
  cloud-quote:
    fontSize: 34px
    fontWeight: 700
    lineHeight: 1.42
    use: Label over the dark quote section on sandollcloud.com, SandollGothicNeo1Unicode, 48.28px line, in white
  cloud-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.61
    use: 'List rows and body copy on sandollcloud.com, SandollGothicNeo1Unicode, 22.54px line, in #333333'
  cloud-tab:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.61
    use: 판매순 / 활성화순 ranking tabs on sandollcloud.com, SandollGothicNeo1Unicode, 20.93px line
rounded:
  cta: 4px
  cloud-button: 6px
  cloud-tab: 19px
  cloud-search: 28px
  cloud-pill: 30px
spacing:
  cta-y: 14
  cta-x: 30
  hero-cta-x: 22
  nav-x: 14
  cloud-button-y: 12
  cloud-button-x: 20
  cloud-tab-y: 5
  cloud-tab-x: 10
components:
  inquiry-cta:
    type: button
    textColor: '#ff0600'
    border: '1px solid #ff0600'
    rounded: 4px
    padding: 14px 30px
    height: 53px
    typography: 16px / 400 / 22.86px SDGretaSans-eRg
    hover: 'bg #ff0600, fg #ffffff, border none'
    pressed: 'bg #ff0600, fg #ffffff, border none'
    states: 'probe: hover and pressed settle on a solid #ff0600 fill with a white label after an all 0.3s ease transition; focus (Tab #28) shows no change'
    use: 제작문의 production-inquiry action in the corporate inquiry block at home::[data-omd-capture="26"], 126 x 53, transparent at rest, linking to /inquiry
  hero-outline-cta:
    type: button
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 4px
    padding: 14px 22px
    height: 59px
    typography: 14px / 400 / 20px SDGretaSans-eRg, letter-spacing 1px
    hover: 'bg #ff0600, border 1px solid #ff0600'
    pressed: 'bg #ff0600, border 1px solid #ff0600'
    states: 'probe: hover and pressed fill #ff0600 after an all 0.3s ease transition; focus (Tab #12) shows no change'
    use: 포트폴리오 outline action over the corporate hero image at home::[data-omd-capture="10"], 131 x 59
  nav-item:
    type: tab
    textColor: '#ffffff over the hero'
    padding: 0px 14px
    height: 40px
    typography: 16px / 400 / 28.8px SDGretaSans-eRg
    selected: 'fg #ff0600 on the current section (the /story header item at surface-2::[data-omd-capture="4"])'
    hover: 'fg #ff0600'
    states: 'probe on home: hover and pressed turn the label #ff0600 after a 0.3s ease-out colour transition; focus (Tab #3) shows no change'
    use: Corporate header navigation items, 40px tall cells with 14px side padding
  portfolio-card:
    type: card
    border: '1px solid #eeeeee'
    rounded: 0px
    size: 393px x 298px
    use: 'Portfolio and story cards on the corporate home and /story (card_wrapper, 18 instances), square-cornered with a #eeeeee hairline'
  cloud-action-button:
    type: button
    backgroundColor: '#4173fa'
    textColor: '#ffffff'
    border: '1px solid #4173fa'
    rounded: 30px
    padding: 12px 20px
    height: 60px
    typography: 14px / 400 / 22.96px SandollGothicNeo1Unicode
    hover: 'bg #345cc8'
    pressed: 'bg #345cc8'
    states: 'probe: hover, pressed and keyboard focus (Tab #110) settle on #345cc8 after an all 0.3s ease transition'
    use: SD 라바 보러가기 (btn-sandoll) over the dark quote section of sandollcloud.com at surface-3::[data-omd-capture="105"], 200 x 60; Sandoll Cloud only
    focus: 'bg #345cc8 on :focus-visible'
  cloud-sort-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#999999'
    border: '1px solid #dddddd'
    rounded: 19px
    padding: 5px 10px
    height: 33px
    typography: 13px / 400 / 20.93px SandollGothicNeo1Unicode
    selected: 'bg #1c1c1c, fg #ffffff, border 1px solid #1c1c1c'
    states: 'probe: neither tab changes on hover, pressed or keyboard focus (Tabs #76 and #77); they declare a 0.15s ease-in-out colour transition'
    use: 판매순 (selected) and 활성화순 font-ranking tabs on sandollcloud.com at surface-3::[data-omd-capture="75"]; Sandoll Cloud only
  cloud-dark-button:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    border: '1px solid #333333'
    rounded: 6px
    padding: 12px 16px
    height: 50px
    typography: 14px / 400 / 22.96px SandollGothicNeo1Unicode
    hover: 'bg #1c1c1c'
    pressed: 'bg #1c1c1c'
    states: 'probe: hover, pressed and keyboard focus (Tab #132) settle on #1c1c1c after an all 0.3s ease transition'
    use: 1:1 문의하기 support action near the foot of sandollcloud.com at surface-3::[data-omd-capture="127"], 180 x 50, with an icon and 8px gap; Sandoll Cloud only
  cloud-carousel-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #dddddd'
    rounded: 50%
    size: 40px x 40px
    states: rest on two captured instances; no state frame and no probe read, so hover, pressed and focus are unmeasured
    use: Round previous and next controls of the sandollcloud.com carousels at surface-3::[data-omd-capture="71"]; Sandoll Cloud only
  cloud-search-input:
    type: input
    textColor: '#999999'
    rounded: 28px
    padding: 14.5px 48px
    height: 52px
    typography: 14px / 400 / 21px SandollGothicNeo1Unicode
    states: rest only; no state frame and no probe read, so hover and focus are unmeasured
    use: Font search field in the sandollcloud.com hero at surface-3::[data-omd-capture="13"], 670 x 52; Sandoll Cloud only
  cloud-story-card:
    type: card
    backgroundColor: '#ebf0ff'
    rounded: 1px
    size: 370px x 604px
    use: Tinted story cards in the sandollcloud.com story carousel (12 instances); Sandoll Cloud only
fonts:
  roles:
    display: SDGretaSans-hBd
    body: SDGretaSans-eRg
    product: SandollGothicNeo1Unicode
---

# Sandoll

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Sandoll; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/sandoll/DESIGN.md
