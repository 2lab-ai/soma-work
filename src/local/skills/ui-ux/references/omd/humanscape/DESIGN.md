---
name: Humanscape
colors:
  primary: '#00adf7'
  accent-hover: '#00a8f6'
  violet: '#7b61ff'
  ink: '#1a1b1e'
  ink-body: '#191a1f'
  charcoal: '#28292d'
  slate: '#3c3d42'
  muted: '#5d5d60'
  faint: '#8c8f96'
  inactive: '#d2d4d9'
  white: '#ffffff'
  surface: '#f4f6f9'
  hairline: '#d8dde4'
typography:
  display-page:
    fontSize: 112px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-3.36px'
    use: 'Page titles on /about-us and /our-business, 146px line, filled with a #7b61ff to #00adf7 gradient clipped to the text'
  display-statement:
    fontSize: 90px
    fontWeight: 500
    lineHeight: 1.3
    use: 'Closing statement heading on home, 117px line, in #1a1b1e'
  display-list:
    fontSize: 72px
    fontWeight: 500
    lineHeight: 1.19
    use: 'Scroll-highlight list on /about-us, 86px line; the active item #00adf7, the others #d2d4d9'
  display-hero:
    fontSize: 58px
    fontWeight: 500
    lineHeight: 1.21
    use: 'Home hero headline, 70px line, in #ffffff over the hero film'
  section:
    fontSize: 52px
    fontWeight: 500
    lineHeight: 1.23
    use: 'Section headlines on home and /about-us, 64px line, in #1a1b1e'
  heading:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.3
    use: 'Home carousel heading, 41.6px line, in #1a1b1e'
  subheading:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Partner and investor names on home, 36px line, in #1a1b1e'
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Leadership names on /about-us, 36px line, in #28292d'
  link-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.56
    use: 'Underlined text links on home, 28px line, in #28292d'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body default, header links and footer links, 24px line
  index-label:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Numbered index labels above the accordion items, 24px line, in #7b61ff'
  button-sm:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.57
    use: 사이트 바로가기 button and its menu, 22px line
  caption:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.57
    use: 'Footer office headings, 22px line, in #5d5d60'
  fine:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Footer copyright line, 18px line, in #8c8f96'
rounded:
  chip: 8px
  card: 24px
  panel: 32px
spacing:
  nav-y: 8
  nav-x: 14
  menu: 16
  row-y: 40
  button-x: 16
components:
  site-link-button:
    type: button
    backgroundColor: '#f4f6f9'
    textColor: '#3c3d42'
    rounded: 8px
    padding: 0px 16px
    height: 44px
    typography: 14px / 500 / 22px Pretendard
    hover: 'fg #00a8f6'
    pressed: 'fg #00a8f6'
    focus: browser default outline only (50% grey, auto 1px); no authored focus style
    states: 'probe on /about-us: transition colours 0.15s cubic-bezier(0.4, 0, 0.2, 1); hover and pressed turn the label azure'
    use: 사이트 바로가기 in the footer of every page; opens the site menu
  site-menu:
    type: card
    backgroundColor: '#f4f6f9'
    textColor: '#3c3d42'
    rounded: 8px
    padding: 16px
    size: 282px x 218px
    typography: 14px / 500 / 21px Pretendard
    states: opened by the collector's menu interaction on all three pages (expanded, menu-open)
    use: Menu of related sites opened from 사이트 바로가기; items are 8px-radius rows
  nav-link:
    type: button
    textColor: '#1a1b1e'
    rounded: 8px
    padding: 8px 14px
    height: 40px
    typography: 16px / 400 / 24px Pretendard
    states: rest only; the bundle's hover, pressed and focus frames on home are mid-transition reads, so no settled state is declared
    use: Header links (About Us, Our Business, Newsroom, Investor Relations, Career) on /about-us and /our-business; on the home hero the same links are white at 90% opacity
  lang-toggle:
    type: toggle
    backgroundColor: '#f4f6f9'
    textColor: '#28292d'
    rounded: 3.35544e+07px (fully rounded)
    padding: 8px 14px
    size: 46px x 38px
    typography: 14px / 600 / 22px Pretendard
    selected: 'the active language (KR) takes the #f4f6f9 pill and 600 weight'
    states: 'inactive EN is transparent, #b0b3ba, 14px / 400; on the home hero the active pill is rgba(244, 246, 249, 0.3) with #f4f6f9 text'
    use: KR / EN switch at the right of the header
  text-link:
    type: button
    textColor: '#28292d'
    border: 'bottom 1px #28292d'
    height: 29px
    typography: 18px / 400 / 28px Pretendard
    states: rest only; the bundle's pressed and focus frames are mid-transition reads, so none is declared
    use: Underlined text links under home section headlines; the site has no filled call-to-action
  accordion-item:
    type: button
    textColor: '#191a1f'
    border: 'bottom 1px #d8dde4'
    padding: 40px 0px
    disabled: the collapsed items carry the disabled attribute at capture
    states: rest and disabled only; no hover frame
    use: Three-step accordion beside the stacked panels on home, each headed by a violet index label
  business-card:
    type: card
    rounded: 24px
    size: 758px x 495px
    use: Business carousel cards on home; the fills are photography, not tokens
  feature-panel:
    type: card
    rounded: 32px
    size: 614px x 286px
    use: Stacked image panels beside the accordion on home
  highlight-list:
    type: listItem
    textColor: '#d2d4d9'
    typography: 72px / 500 / 86px Pretendard
    selected: 'fg #00adf7 on the item in view'
    use: Scroll-highlight word list on /about-us
fonts:
  roles:
    body: Pretendard
---

# Humanscape

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Humanscape; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/humanscape/DESIGN.md
