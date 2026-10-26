---
name: MediBloc
colors:
  primary: '#0066ff'
  white: '#ffffff'
  ink: '#333333'
  field-text: '#393939'
  muted: '#848484'
  black: '#000000'
  link: '#cc3366'
typography:
  display-hero:
    fontSize: 60px
    fontWeight: 400
    lineHeight: 1.4
    use: Home hero headline (Own your health data. It's rightfully yours.) in the Pretendard-Bold cut, 84px line, white
  section:
    fontSize: 41px
    fontWeight: 400
    lineHeight: 1.5
    use: Home section headings (Panacea, Ecosystem, Stake and Earn, Latest News) in Pretendard-Bold, 61.5px line, white
  section-sm:
    fontSize: 30px
    fontWeight: 400
    lineHeight: 1.5
    use: Paired guide headings (Stake MED, Earn MED; Stake MED LP, Earn OSMO) in Pretendard-Bold, 45px line
  post-title:
    fontSize: 45px
    fontWeight: 200
    lineHeight: 1.2
    use: 2023 post headline in Montserrat, 54px line, white on black
  post-heading:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.2
    use: Section headings inside the 2023 post, system stack, 38.4px line
  lead:
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.5
    use: Section lead paragraphs on home in Pretendard-Regular, 28.5px line
  card-title:
    fontSize: 18px
    fontWeight: 300
    lineHeight: 1.5
    use: Blog card titles on /blog/ in Montserrat, 27px line, white
  hero-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
    use: Hero paragraphs on home in Pretendard-Medium, 27.2px line, white
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Page default and post paragraphs, system stack, 24px line
  footer-link:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Footer link lists in Pretendard-Regular, 24px line, #cc3366'
  button:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 2.8
    letterSpacing: 1px
    use: Outlined call-to-action labels in Pretendard-SemiBold, 42px line, 1px tracking
  footer-heading:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Footer column headings (Network, Resources, Communities) in Pretendard-Medium, 22.5px line
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Grey footnotes on home in Pretendard-Regular, 21px line, #848484'
  nav:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.71
    letterSpacing: '-0.45px'
    use: Header links (Blog, Telegram, Twitter, Github); the stack starts at Roboto and no Roboto webfont is loaded
rounded:
  field: 3px
  button: 4px
spacing:
  button-x: 50
  text-button-y: 12
  text-button-x: 24
  nav-y: 4
  nav-x: 7
  field-y: 8
  field-x: 16
components:
  outline-button:
    type: button
    backgroundColor: transparent (rgba(3, 1, 27, 0))
    textColor: '#0066ff'
    border: '2px solid #0066ff'
    rounded: 4px
    padding: 0px 50px
    height: 62px
    typography: 15px / 400 / 42px Pretendard-SemiBold, letter-spacing 1px
    shadow: rgba(0, 0, 0, 0.07) 0px 10px 20px 0px
    states: rest only; no state frame was captured and the fixed probe was not run (browser use was barred for this capture), so no hover, pressed or focus value is declared
    use: Outlined calls-to-action on home (Circulating Supply, Validator Guide, Delegator Guide, A to Z guide; Apply for Token swap at 14px Pretendard-Medium) at home::[data-omd-capture="8"], 222-283 x 62
  text-button:
    type: button
    backgroundColor: transparent (rgba(235, 241, 255, 0))
    textColor: '#0066ff'
    rounded: 3px
    padding: 12px 24px
    height: 39px
    typography: 15px / 500 / 15px Pretendard-Medium
    states: rest only; no state frame
    use: See more company news under Latest News on home, 240 x 39
  send-button:
    type: button
    textColor: '#ffffff'
    rounded: 3px
    padding: 0px 16px
    height: 40px
    typography: 16px / 500 / 16px Pretendard-Medium
    states: rest only; no state frame
    use: Send at the foot of the contact form on all three pages, 282 x 40; the button and its recorded wrapper compute transparent, so no fill is declared
  see-more-toggle:
    type: toggle
    textColor: '#0066ff'
    typography: 17px / 400 / 13.6px Pretendard-Medium
    states: rest only; no state frame
    use: See more toggle in the Ecosystem section on home, 73 x 21
  accordion-title:
    type: tab
    padding: 15px
    height: 46px
    states: rest only; no state frame
    use: Ecosystem accordion row on home (role=button), 676 x 46; its visible label is the blue See more toggle inside it, so the row computes only inherited text values and no label colour or font is declared
  nav-link:
    type: tab
    textColor: '#ffffff'
    padding: 4px 7px
    height: 32px
    typography: 14px / 500 / 24px Roboto (system), letter-spacing -0.45px
    selected: 'fg #000000 on the current page item (Blog on /blog/)'
    states: selected variant read from rest values; no pointer frame
    use: Header links Blog, Telegram, Twitter, Github on all three pages
  text-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#393939'
    rounded: 3px
    padding: 8px 16px
    height: 40px
    typography: 15px / 400 / 21px Lato_Regular
    states: rest only; the declared border colour has 0px width
    use: Email field of the contact form, 137 x 40
  select-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#393939'
    rounded: 3px
    padding: 5px 20px 5px 14px
    height: 40px
    typography: 16px / 400 / 24px Lato_Regular
    states: rest only
    use: Category select of the contact form, 282 x 40
  textarea-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#393939'
    rounded: 3px
    padding: 5px 14px
    height: 94px
    typography: 15px / 400 / 21px Lato_Regular
    states: rest only
    use: Message field of the contact form, 282 x 94
  post-card:
    type: card
    size: 437px x 426px
    use: 'Blog post card on /blog/ (nine instances): 306px thumbnail link above a white Montserrat 18px / 300 title'
fonts:
  roles:
    display: Pretendard
    editorial: Montserrat
    form: Lato
---

# MediBloc

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MediBloc; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/medibloc/DESIGN.md
