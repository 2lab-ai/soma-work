---
name: Sinsang Market (Dealicious)
colors:
  primary: '#222222'
  on-primary: '#ffffff'
  accent: '#1a2241'
  ink: '#000000'
  slate: '#3e4149'
  grey: '#686e7b'
  muted: '#8f97a7'
  faint: '#bec5d2'
  faint-alt: '#a6adbd'
  white: '#ffffff'
  hairline: '#dfe3ed'
  divider: '#ebeef6'
typography:
  display-hero:
    fontSize: 60px
    fontWeight: 700
    lineHeight: 1.5
    use: Home hero headline (고객의 사업을 쉽고 즐겁게), 90px line, white over the hero image
  page-title:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    use: 'IR page title, 54px line, #222222'
  section:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Section headings on home, IR and career, 45px line, #3e4149'
  banner-title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Recruiting and blog banner headings (딜리셔스와 함께할 멋진 동료를 찾습니다, 딜리셔스의 개발 이야기), 42px line, white or #3e4149'
  story-title:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Story headings on home, 39px line, #3e4149'
  caption-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Story descriptions on home, 30px line, #8f97a7'
  button:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.5
    use: Pill labels (인재영입 바로가기, 블로그 바로가기), 27px line
  filter:
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.18
    use: Selected career filter label, 20px line; unselected filters are weight 400
  eyebrow:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1.6px
    use: 'Small label above the IR title, 24px line, #8f97a7'
  list-title:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Disclosure titles on the IR page, 24px line, #3e4149'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default, 24px line, #000000'
  footer:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Footer contact lines, 22.5px line, #3e4149'
  fine:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.71
    use: 'Footer company disclosure, 24px line, #3e4149'
rounded:
  filter: 40px
  pill: 50px
spacing:
  pill-y: 14
  pill-x: 31
  filter-y: 14
  filter-x: 20
  chip-y: 10
  chip-x: 18
components:
  recruit-pill:
    type: button
    backgroundColor: '#222222'
    textColor: '#ffffff'
    rounded: 50px
    padding: 14px 31px
    height: 55px
    typography: 18px / 700 / 27px Roboto
    states: 'probe: hover and pressed change nothing on the button; the banner card around it lifts (see banner-card); focus draws only the browser ring'
    use: 인재영입 바로가기, the one filled call to action, in the recruiting banner card at home::[data-omd-capture="17"], 219 x 55
  blog-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3e4149'
    rounded: 50px
    padding: 14px 31px
    height: 55px
    typography: 18px / 700 / 27px Roboto
    states: 'probe: hover and pressed change nothing on the button; its banner card lifts; focus draws only the browser ring'
    use: 블로그 바로가기 in the tech-blog banner card on home (home::[data-omd-capture="19"]) and the career page, 202 x 55
  banner-card:
    type: card
    shadow: rgba(34, 34, 34, 0.08) 4px 10px 20px 0px
    hover: shadow rgba(34, 34, 34, 0.18) 4px 12px 20px 6px and a 5px lift (translateY -5px)
    pressed: same as hover
    states: hover and pressed read by the probe on the card that holds each pill; the card's class names a 20px radius, which was not read as a computed value
    use: The two banner cards (recruiting and tech blog) near the foot of home and the other pages; read by the fixed probe as the pills' ancestor
  career-filter:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#a6adbd'
    border: '1px solid #dfe3ed'
    rounded: 40px
    padding: 14px 20px
    height: 50px
    typography: 17px / 400 / 20px Roboto
    selected: 'bg #1a2241, fg #ffffff, border #1a2241, weight 700'
    hover: 'bg #f5f6fb'
    pressed: 'bg #f5f6fb'
    states: 'unselected filters take a #f5f6fb fill on hover and pressed after a 0.2s transition; the selected filter shows no change; focus draws only the browser ring'
    use: Job category filters on the career page (전체, 제품/서비스, 경영지원) at surface-3::[data-omd-capture="7"]
  ir-tab:
    type: tab
    textColor: '#8f97a7'
    typography: 16px / 400 / 24px Roboto
    selected: 'fg #222222, weight 700'
    hover: 'fg #3e4149'
    pressed: 'fg #3e4149'
    states: 'unselected tabs darken to #3e4149 on hover and pressed after a 0.15s transition; the selected tab shows no change; focus draws only the browser ring'
    use: IR section tabs (일반공고, 전자공시(DART), IR 자료실, IR CONTACT) at surface-2::[data-omd-capture="7"]
  language-pill:
    type: button
    textColor: '#3e4149'
    border: '1px solid #dfe3ed'
    rounded: 40px
    padding: 10px 18px
    height: 43px
    typography: 14px / 500 / 21px Roboto
    hover: 'bg #f5f6fb'
    pressed: 'bg #f5f6fb'
    states: 'hover and pressed fill #f5f6fb after a 0.15s transition; focus draws only the browser ring'
    use: 국문 language selector on the IR page at surface-2::[data-omd-capture="17"], 86 x 43
  disclosure-row:
    type: listItem
    textColor: '#000000'
    border: '0px 0px 1px solid #ebeef6'
    height: 73px
    typography: 16px / 400 / 24px Roboto
    use: 'Rows of the IR disclosure list at surface-2::[data-omd-capture="10"], 1198 x 73, divided by #ebeef6'
  language-switch:
    type: tab
    textColor: '#bec5d2'
    typography: 15px / 700 / 22.5px Roboto
    selected: 'fg #222222'
    states: selected read from rest values; no pointer frame
    use: 한국어, ENG, 中文 and 日文 in the footer of every page at home::[data-omd-capture="36"]
fonts:
  roles:
    sans: Roboto
---

# Sinsang Market (Dealicious)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Sinsang Market (Dealicious); reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/dealicious/DESIGN.md
