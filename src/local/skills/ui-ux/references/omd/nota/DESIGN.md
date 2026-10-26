---
name: Nota AI
colors:
  primary: '#3264f0'
  ink: '#101218'
  navy: '#252a39'
  white: '#ffffff'
  hairline: '#ececf1'
  surface: '#f6f6f8'
  border: '#cccccc'
  hero-link: '#e7e7e7'
  muted: '#aaaaaa'
typography:
  display-hero:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.35
    use: Largest home headline, 70.2px line
  display-section:
    fontSize: 43.2px
    fontWeight: 400
    lineHeight: 1.38
    use: Section-level h1 headlines, 59.6px line
  eyebrow:
    fontSize: 21.36px
    fontWeight: 400
    lineHeight: 1.46
    use: Newsroom and Tech Blog labels over the home feed, 31.3px line
  list:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.6
    use: 'Feature lists on the NetsPresso page, 28.8px line, in #101218'
  card-title:
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: 0.17px
    use: 'Blog card titles on home, 24.65px line, in #252a39'
  nav:
    fontSize: 16.68px
    fontWeight: 400
    lineHeight: 1.5
    use: Header folder titles (NetsPresso®, AI Solutions, Company), 25px line
  tab:
    fontSize: 16px
    fontWeight: 700
    use: Product tabs in the home hero
  small:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Default small text in cards, 18px line
  tag:
    fontSize: 11.5px
    fontWeight: 600
    use: Category tag on blog cards
rounded:
  control: 4px
  slider: 8px
  card: 10px
  tag: 999px
spacing:
  card-y: 10
  card-x: 22
  button-y: 16
  button-x: 30
  tag-y: 3
  tag-x: 9
components:
  blog-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#101218'
    border: '1px solid #ececf1'
    rounded: 10px
    size: 383px x 333px
    hover: 'border #3264f0, shadow rgba(37, 42, 57, 0.1) 0px 6px 12px, lifts 4px'
    pressed: same as hover
    states: 'probe: border, shadow and a 4px lift over 0.18s ease; focus not measured'
    use: 'Blog feed cards on home (Newsroom and Tech Blog), thumbnail on #f6f6f8, title in #252a39'
  blog-tag:
    type: badge
    backgroundColor: rgba(50, 100, 240, 0.08)
    textColor: '#3264f0'
    rounded: 999px
    padding: 3px 9px
    height: 24px
    typography: 11.5px / 600
    use: Category tag (Tech and others) at the top of each blog card
  hero-tab:
    type: tab
    textColor: rgba(255, 255, 255, 0.55)
    selected: 'fg #ffffff'
    typography: 16px / 700
    hover: fg rgba(255, 255, 255, 0.85)
    pressed: fg rgba(255, 255, 255, 0.85)
    states: 'probe on an inactive tab: label brightens from 55% to 85% white over a 0.3s ease-out colour transition; the active tab computes #ffffff; focus not measured'
    use: Product tabs in the home hero (NetsPresso®, Nota Vision Agent, Industrial Safety) over the dark hero
  hero-link:
    type: button
    textColor: '#e7e7e7'
    padding: 0px 0px 2px
    typography: 16px / 700
    hover: a 1px ::after underline grows to full width
    pressed: same as hover
    states: 'probe: the underline grows over up to 600ms; focus not measured'
    use: Learn More → under the hero tabs
  netspresso-button:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.95)
    textColor: '#101218'
    rounded: 8px
    padding: 16px 30px
    height: 50px
    states: the bundle marks a pressed frame but stores no changed value, and the button was not probed, so no hover or pressed value is declared
    use: Try NetsPresso® on the NetsPresso page, 183 x 50; the label sits in a child element the collector did not record, so no label font is declared
  lang-button:
    type: button
    textColor: '#aaaaaa'
    rounded: 4px
    padding: 6px
    typography: 15px / 400
    states: rest only; the bundle's focus frame is not used to declare a focus style
    use: KOR / ENG switch in the header of all three pages
  nav-folder:
    type: button
    textColor: '#ffffff'
    typography: 16.68px / 400
    states: 'rest only; the same titles compute #101218 over the light NetsPresso header'
    use: Header folder titles over the dark home and company heroes
  partner-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    padding: 10px 22px
    shadow: rgba(141, 141, 141, 0.15) 10px 10px 28px 0px
    use: Partner logo cards on home (40 instances)
  slider-card:
    type: card
    border: '1px solid #cccccc'
    rounded: 8px
    size: 463px x 477px
    use: Use-case slider cards on the NetsPresso page, with a rgba(0, 0, 0, 0.5) title bar in 20px white Roboto
fonts:
  roles:
    display: Roboto
    body: Roboto
---

# Nota AI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Nota AI; reproduced for educational reference. Full prose: https://oh-my-design.kr/nota/design.md
