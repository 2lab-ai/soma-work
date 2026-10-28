---
name: KB Pay
colors:
  primary: '#ffcc00'
  on-primary: '#000000'
  heading: '#151515'
  text: '#333333'
  footer-text: '#444444'
  muted: '#666666'
  border: '#aaaaaa'
  hover-fill: '#ebebeb'
  select-border: '#c2c2c2'
  surface: '#f9fafc'
  white: '#ffffff'
  grid-line: '#e1e1e1'
typography:
  display:
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-1px'
    use: Page title (KB Pay) on the KB Pay pages, KBFGDisplayM, 32px line, in rgba(0, 0, 0, 0.87)
  display-home:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.25
    use: Hero slide titles on the KB국민카드 home, KBFGDisplayM, 40px line
  section:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-1px'
    use: 'Section headings on the KB Pay pages (서비스 특징, 이용전 유의사항), KBFGDisplayM, 24px line, in #151515'
  lead:
    fontSize: 24px
    fontWeight: 400
    use: 'Tagline 한번에, 한손에, 한눈에 KB Pay on the KB Pay 소개 page, KBFGText, in #333333'
  subsection:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-1px'
    use: 'Sub-headings on KB Pay 이용, KBFGDisplayM, 18px line, in #333333'
  card-title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.6
    use: Card headings on the KB국민카드 home, KBFGText, 28.8px line
  tab-lg:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.45
    use: Section tabs on the KB국민카드 home, KBFGText, 26.1px line, with a 3px underline when current
  button-lg:
    fontSize: 18px
    fontWeight: 600
    use: 로그인 label of the yellow primary button on the KB국민카드 home
  category:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.41
    use: Merchant category links on KB Pay 가맹점, 24px line, weight 600 when current
  nav:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.73
    use: Main navigation (My KB, 혜택, 금융, 카드, 서비스, 라이프), KBFGText, 26px line
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.47
    use: Introductory copy on the KB Pay 소개 page, KBFGText, 22px line
  body-home:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
    use: Card and banner copy on the KB국민카드 home, 24px line
  button-sm:
    fontSize: 14px
    fontWeight: 400
    use: Header 로그인 label, KBFGText
  footer:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: 'Footer links, KBFGText and KBFGTextM, 20px line, in #444444'
  util:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.54
    use: 'Utility links in the top bar, 20px line, in #666666'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Footer copyright, 18px line, in #666666'
rounded:
  button-sm: 3px
  button: 4px
  segment: 6px
  card: 16px
spacing:
  gnb-y: 27
  tab-x: 8
  segment-x: 24
  card-x: 32
  card-y: 20
components:
  primary-button:
    type: button
    backgroundColor: '#ffcc00'
    textColor: '#000000'
    rounded: 4px
    padding: 0px 16px
    height: 48px
    typography: 18px / 600 / 48px KBFGText
    states: 'probe on the KB국민카드 home: hover and pressed show no change across the button and three ancestor levels (transition all 0s); focus was not read, so none is declared'
    use: 로그인 in the login panel of the KB국민카드 home at surface-2::[data-omd-capture="30"], 344 x 48; the only filled action on the four captured pages
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  header-login:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #aaaaaa'
    rounded: 3px
    height: 42px
    typography: 14px / 400 / 40px KBFGText
    hover: 'bg #ebebeb'
    pressed: 'bg #ebebeb'
    states: bundle hover and pressed frames on all four pages; focus not declared
    use: 로그인 in the header of every captured page at home::[data-omd-capture="15"], 82 x 42
  page-tab:
    type: tab
    textColor: rgba(0, 0, 0, 0.87)
    padding: 8px
    height: 64px
    typography: 15px / 400 KBFGText
    selected: 3px bottom border rgba(0, 0, 0, 0.87), padding 8px 8px 5px
    hover: the same 3px bottom border appears
    pressed: the same 3px bottom border appears
    states: selected from rest values; hover and pressed from bundle frames; focus not declared
    use: KB Pay 소개, KB Pay 이용, KB Pay 가입, KB Pay 가맹점 tabs under the page title, 110 to 125 x 64
  segment-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: rgba(0, 0, 0, 0.87)
    border: 1px solid rgba(0, 0, 0, 0.16)
    rounded: 6px
    padding: 12px 24px 10px
    height: 48px
    typography: 15px / 400 / 21.75px KBFGText
    selected: 2px solid rgba(0, 0, 0, 0.87) border, weight 600, padding 11px 23px 9px
    hover: 2px solid rgba(0, 0, 0, 0.87) border, weight 600
    pressed: 2px solid rgba(0, 0, 0, 0.87) border, weight 600
    states: selected from rest values; hover and pressed from bundle frames; focus not declared
    use: Second-level tabs on KB Pay 이용 at surface-3::[data-omd-capture="23"], 103 to 120 x 48
  outline-button-xs:
    type: button
    backgroundColor: '#ffffff'
    textColor: rgba(0, 0, 0, 0.87)
    border: 1px solid rgba(0, 0, 0, 0.6)
    rounded: 4px
    padding: 0px 10px
    height: 32px
    typography: 13px / 400 / 34px KBFGText
    states: rest only; no state frame and not probed
    use: Small outlined link buttons in the KB Pay 이용 guide at surface-3::[data-omd-capture="24"], 159 x 32
  gnb-item:
    type: tab
    textColor: rgba(0, 0, 0, 0.87)
    padding: 27px 0px
    height: 80px
    typography: 15px / 400 / 26px KBFGText
    states: rest only; no state frame
    use: Main navigation items in the 80px header row of the KB Pay pages
  audience-switch:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#333333'
    padding: 18px 0px 22px
    height: 60px
    typography: 14px / 400 / 20px KBFGText
    selected: weight 600 (class menuON)
    hover: weight 600
    pressed: weight 600
    states: selected from rest values; hover and pressed from bundle frames; focus not declared
    use: The three audience switches at the left of the 60px top bar
  merchant-category:
    type: tab
    textColor: rgba(0, 0, 0, 0.87)
    height: 24px
    typography: 17px / 400 / 24px KBFGText
    selected: weight 600 with a 1px bottom border rgba(0, 0, 0, 0.87)
    hover: weight 600 with a 1px bottom border
    pressed: weight 600 with a 1px bottom border
    states: selected from rest values; hover and pressed from bundle frames; focus not declared
    use: Merchant category links above the logo grid on KB Pay 가맹점
  family-site:
    type: button
    textColor: '#666666'
    border: '1px solid #c2c2c2'
    rounded: 0px
    padding: 0px 25px 0px 15px
    height: 34px
    typography: 14px / 400 / 32px KBFGText
    states: rest only; no state frame
    use: Family-site box in the footer of every captured page, 196 x 34
  recommendation-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    shadow: rgba(0, 0, 0, 0.16) 0px 1px 3px 0px
    size: 1080px x 541px
    use: Recommendation panel on the KB국민카드 home
  finance-menu-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    shadow: rgba(0, 0, 0, 0.16) 0px 1px 3px 0px
    padding: 24px 0px 0px 32px
    size: 344px x 176px
    use: Finance menu tiles on the KB국민카드 home (smaller tiles 160 x 80)
  guide-card:
    type: card
    backgroundColor: '#f9fafc'
    rounded: 16px
    padding: 20px 32px
    size: 528px x 106px
    use: Customer guide link on the KB국민카드 home at surface-2::[data-omd-capture="68"]
  info-box:
    type: card
    backgroundColor: '#f9fafc'
    rounded: 4px
    padding: 16px 32px
    size: 1016px x 105px
    use: Notice box (braille-card) on the KB국민카드 home
  merchant-cell:
    type: card
    border: '1px solid #e1e1e1 (top and sides)'
    size: 192px x 149px
    use: Merchant logo grid on KB Pay 가맹점
fonts:
  roles:
    display: KBFGDisplayM
    body: KBFGText
---

# KB Pay

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KB Pay; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kbpay/DESIGN.md
