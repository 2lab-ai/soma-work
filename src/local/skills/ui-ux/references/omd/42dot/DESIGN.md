---
name: 42dot
colors:
  primary: '#5a46fa'
  on-primary: '#ffffff'
  ink: '#171717'
  heading: '#0d0d0d'
  body: '#333333'
  muted: '#666666'
  slate: '#737d8c'
  faint: '#aaaaaa'
  graphite: '#32353f'
  mist: '#f6f6f9'
  hairline: '#dddddd'
  white: '#ffffff'
typography:
  display-hero:
    fontSize: 67.5px
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: '-2.025px'
    use: 'Home key-visual headline (Advancing Mobility, Realizing Possibilities), techSans, 77.625px line, in #ffffff over the hero video; set on a p element'
  page-title:
    fontSize: 32.4px
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: '-0.162px'
    use: 'Page headlines on /company/about and /stories/blog-news, techSans, 43.74px line, in #0d0d0d (#171717 on blog-news)'
  section:
    fontSize: 27px
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: '-0.054px'
    use: 'Blog heading on /stories/blog-news, Asta Sans, 36.45px line, in #0d0d0d'
  band-title:
    fontSize: 21.6px
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: '-0.108px'
    use: 'Careers band heading on home, Asta Sans, 31.32px line, in #ffffff'
  card-title:
    fontSize: 18.9px
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: '-0.0945px'
    use: 'Link-card headings at the foot of /company/about (Global One Team), Asta Sans, 27.405px line, in #0d0d0d'
  milestone:
    fontSize: 16.2px
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: '-0.081px'
    use: 'Milestone text in the Our Journey So Far timeline on /company/about, Asta Sans, 23.49px line, in #ffffff'
  lead:
    fontSize: 13.5px
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: '-0.068px'
    use: 'Home hero description under the headline, Asta Sans, 19.575px line, in #ffffff'
  tab:
    fontSize: 13.5px
    fontWeight: 500
    lineHeight: 1.45
    use: Blog category tabs (전체, Publication, Tech, Insight, Culture), Asta Sans, 19.575px line
  intro:
    fontSize: 12.15px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.061px'
    use: Banner description on /stories/blog-news and intro copy on /company/about, Asta Sans, 18.225px line
  body:
    fontSize: 10.8px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.054px'
    use: 'Link-card descriptions on /company/about, Asta Sans, 16.2px line, in #333333; the document default is also 10.8px Asta Sans in #171717'
  nav:
    fontSize: 10.8px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Header navigation labels (SDV, AI, Company, Stories), techSans, 16.2px line, in #0d0d0d'
  button:
    fontSize: 10.8px
    fontWeight: 400
    lineHeight: 1.5
    use: Careers label in the header, techSans, 16.2px line
  pill-label:
    fontSize: 9.45px
    fontWeight: 500
    lineHeight: 1.57
    letterSpacing: '-0.047px'
    use: Pill link labels (Explore Stories, Open Roles, Explore Locations), Asta Sans, 14.85px line
  tag:
    fontSize: 9.45px
    fontWeight: 500
    lineHeight: 1.71
    use: Blog tag filter labels, Asta Sans, 16.2px line
  submenu:
    fontSize: 9.45px
    fontWeight: 500
    lineHeight: 1.55
    use: 'Header dropdown sub-items in #666666, techSans, 14.6475px line'
rounded:
  none: 0px
  tag: 5.4px
  badge: 6.75px
  field: 33.75px
  pill: 67.5px
spacing:
  cta-y: 6.75
  cta-x: 18.9
  pill-y: 8.1
  pill-x: 13.5
  tag-y: 2.025
  tag-x: 7.425
  badge-x: 8.1
  tab-bottom: 5.4
components:
  careers-button:
    type: button
    backgroundColor: '#5a46fa'
    textColor: '#ffffff'
    rounded: 67.5px
    padding: 6.75px 18.9px
    height: 29.7px
    typography: 10.8px / 400 / 16.2px techSans
    hover: 'bg #ffffff, fg #0d0d0d, while the header bar behind it turns from rgba(255, 255, 255, 0.6) to solid #ffffff'
    pressed: 'bg #ffffff, fg #0d0d0d'
    states: hover and pressed settle after a 0.3s background-color and color transition (probe on /stories/blog-news and /company/about); the focus reading persisted after blur, so no focus style is attributed
    use: Careers in the fixed header of all three captured pages at home::[data-omd-capture="15"], 75.5 x 29.7; the only filled chromatic action on the site
  pill-link:
    type: button
    backgroundColor: '#32353f'
    textColor: '#ffffff'
    rounded: 67.5px
    padding: 8.1px 13.5px 8.1px 16.2px
    height: 31px
    typography: 9.45px / 500 / 14.85px Asta Sans, letter-spacing -0.04725px
    hover: 'bg #737d8c; the trailing arrow moves 2.025px right'
    pressed: 'bg #737d8c'
    states: '0.15s background transition; focus (Tab #34) draws only the browser default ring, so no brand focus style is declared'
    use: Dark pill links on /company/about (Explore Locations, Open Roles, Explore Stories) at surface-2::[data-omd-capture="27"], 108 x 31 for Explore Stories
  pill-link-light:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0d0d0d'
    rounded: 67.5px
    padding: 8.1px 13.5px 8.1px 16.2px
    height: 31px
    typography: 9.45px / 500 / 14.85px Asta Sans, letter-spacing -0.04725px
    states: rest only; no state frame or probe
    use: White pill link in the lower part of home at home::[data-omd-capture="29"], 92 x 31, the light counterpart of the dark pill
  tag-filter:
    type: badge
    textColor: '#333333'
    border: '1px solid #dddddd'
    rounded: 5.4px
    padding: 2.025px 7.425px
    height: 22px
    typography: 9.45px / 500 / 16.2px Asta Sans
    hover: 'bg #f6f6f9'
    pressed: 'bg #f6f6f9'
    states: '0.2s background-color transition; focus (Tab #31) shows no change'
    use: 'Filter by Tags buttons on /stories/blog-news (#3DOccupancyPrediction, #AKit, #Autonomous and others, 85 instances) at surface-3::[data-omd-capture="26"], transparent at rest'
  category-tab:
    type: tab
    textColor: '#333333'
    border: 2px solid transparent (bottom only)
    padding: 0px 0px 5.4px
    height: 27px
    typography: 13.5px / 500 / 19.575px Asta Sans
    selected: 'fg #0d0d0d with a 2px solid #5a46fa bottom border'
    hover: 'fg #0d0d0d'
    pressed: 'fg #0d0d0d'
    states: '0.2s color transition on unselected tabs; the selected tab shows no change; focus (Tabs #118 and #120) shows no change on either'
    use: Blog category tabs on /stories/blog-news (전체, Publication, Tech, Insight, Culture) at surface-3::[data-omd-capture="114"]
  nav-item:
    type: tab
    textColor: '#0d0d0d'
    height: 16px
    typography: 10.8px / 500 / 16.2px techSans
    selected: 'fg #5a46fa on the current section (Company on /company/about, Stories on /stories/blog-news)'
    states: hover and pressed widen the button box from 44.3px to 97.9px with no colour change; the focus reading persisted after blur and is not attributed
    use: Header navigation labels at home::[data-omd-capture="1"] (SDV, AI, Company, Stories)
  story-badge:
    type: badge
    backgroundColor: '#f6f6f9'
    textColor: '#0d0d0d'
    rounded: 6.75px
    padding: 2.7px 8.1px
    height: 20px
    typography: 9.45px / 500 / 14.6475px Asta Sans
    use: Category badges on the Tech and Stories cards on home (5 instances) at home::span
  search-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0d0d0d'
    border: '1px solid #dddddd'
    rounded: 33.75px
    padding: 8.775px 51.3px 8.1px 15.984px
    height: 38px
    typography: 16px / 400 / 24px Asta Sans, letter-spacing -0.08px
    states: rest only; no state frame or probe reading
    use: Search field on /stories/blog-news at surface-3::[data-omd-capture="24"], 248 x 38
  search-field-dark:
    type: input
    backgroundColor: rgba(0, 0, 0, 0.4)
    textColor: '#ffffff'
    border: 1px solid rgba(255, 255, 255, 0.1)
    rounded: 33.75px
    height: 54px
    typography: 16px / 400 / 24px Asta Sans, letter-spacing -0.08px
    states: rest only; the bundle's focus and pressed frames are not used (focus is never declared from bundle frames and no probe read this field)
    use: Translucent field under the careers heading on home at home::[data-omd-capture="23"], 509 x 54
  pagination-page:
    type: button
    textColor: '#aaaaaa'
    rounded: 5.4px
    size: 27px x 27px
    typography: 10.8px / 600 / 16.2px Asta Sans
    selected: 'bg #737d8c, fg #ffffff'
    disabled: the previous arrow is disabled at rest in rgba(16, 16, 16, 0.3)
    use: Blog pagination on /stories/blog-news; idle pages at surface-3::[data-omd-capture="129"], current page at surface-3::[data-omd-capture="128"]
  video-play-button:
    type: button
    border: '1px solid #ffffff'
    rounded: 100% (circle)
    size: 43px x 43px
    states: rest only; a bundle hover frame shows a white fill, but no probe confirmed it, so no hover is declared
    use: Circular play control over the home hero video at home::[data-omd-capture="22"]; a 54 x 54 version sits over the /company/about video
  footer-select:
    type: button
    textColor: '#dddddd'
    border: 1px solid rgba(255, 255, 255, 0.2)
    rounded: 33.75px
    padding: 0px 14.85px 0px 18.9px
    height: 31px
    typography: 10.8px / 400 / 16.2px Asta Sans, letter-spacing -0.054px
    states: rest only; no state frame or probe reading
    use: Family Site toggle in the footer of all three pages at home::[data-omd-capture="56"], 146 x 31
fonts:
  roles:
    display: techSans
    body: Asta Sans
---

# 42dot

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 42dot; reproduced for educational reference. Full prose: https://oh-my-design.kr/42dot/design.md
