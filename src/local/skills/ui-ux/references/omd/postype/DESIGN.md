---
name: POSTYPE
colors:
  primary: '#2c2c2f'
  primary-hover: '#000000'
  primary-pressed: '#3e3e43'
  on-primary: '#ffffff'
  ink: '#141415'
  body: '#62626a'
  muted: '#76767f'
  disabled: '#a4a4a8'
  link: '#3478ff'
  info: '#1a66ff'
  info-surface: '#ebf2ff'
  info-border: '#dbe7fe'
  alert-red: '#f33d4d'
  surface: '#f2f2f3'
  surface-pressed: '#eaeaeb'
  hairline: '#eaeaeb'
  white: '#ffffff'
  focus-ring: '#3478ff'
typography:
  heading:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Page h1 on home, 48px line, #141415'
  section:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-0.5px'
    use: 'Feed and shelf headings on home (h2), 26.67px line, -0.5px tracking, #141415'
  item-title:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Post titles in the home feed (h3), 24px line, #141415'
  card-title:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.5
    use: 'Titles inside home cards, 22.5px line, #141415'
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default on home and @team, 24px line, #141415'
  body-secondary:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Post excerpts in the home feed, 24px line, #62626a'
  button:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.33
    use: Header 회원 가입 and 로그인 labels, 20px line
  button-sm:
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.33
    use: Compact button labels on home, 17.33px line
  menu:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Overflow-menu items, 22.5px line
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Secondary sidebar list items, 21px line, #2c2c2f'
  meta:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Dates and counts under posts, 18px line, #76767f'
  chip:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    use: Tag chips under posts, 16.5px line
rounded:
  small: 6px
  button: 8px
  card: 12px
  chip: 24px
spacing:
  button-y: 6
  button-x: 16
  button-sm-y: 4
  button-sm-x: 12
  list-y: 4
  list-x: 12
  menu: 8
  card: 16
  feed-y: 20
  chip-x: 6
components:
  signup-button:
    type: button
    backgroundColor: '#2c2c2f'
    textColor: '#ffffff'
    rounded: 8px
    padding: 6px 16px
    height: 40px
    typography: 15px / 600 / 20px
    hover: 'bg #000000'
    pressed: 'bg #3e3e43'
    focus: 'outline 2px solid #3478ff, offset 2px'
    states: 'bundle frames and the probe agree on hover #000000 and pressed #3e3e43; transition all 0s; keyboard focus draws a 2px #3478ff ring offset 2px'
    use: 회원 가입 in the header of home and @team at home::[data-omd-capture="5"], 87 x 40, linking to /signup
  login-button:
    type: button
    backgroundColor: transparent
    textColor: '#2c2c2f'
    border: '1px solid #eaeaeb'
    rounded: 8px
    padding: 6px 16px
    height: 40px
    typography: 15px / 600 / 20px
    hover: 'bg #f2f2f3'
    pressed: 'bg #eaeaeb'
    focus: 'outline 2px solid #3478ff, offset 2px'
    states: bundle frames and the probe agree; transition all 0s
    use: 로그인 beside 회원 가입 in the header, 73 x 40
  subscribe-button:
    type: button
    backgroundColor: '#2c2c2f'
    textColor: '#ffffff'
    rounded: 8px
    padding: 6px 16px
    height: 40px
    typography: 15px / 600 / 20px
    states: rest only on this instance
    use: 구독 on the @team channel header at surface-3::[data-omd-capture="26"], 96 x 40; logged out it links to /login
  tonal-button:
    type: button
    backgroundColor: '#f2f2f3'
    textColor: '#2c2c2f'
    rounded: 8px
    padding: 4px 12px
    height: 32px
    typography: 13px / 600 / 17.33px
    states: rest only
    use: Compact grey buttons in the home right column (eight instances), e.g. home::[data-omd-capture="33"], 46 x 32
  outline-button-sm:
    type: button
    backgroundColor: transparent
    textColor: '#2c2c2f'
    border: '1px solid #eaeaeb'
    rounded: 8px
    padding: 4px 12px
    height: 32px
    typography: 13px / 600 / 17.33px
    states: rest only
    use: Compact outlined buttons in the home feed (24 instances), e.g. home::[data-omd-capture="85"], 188 x 32
  sidebar-item:
    type: button
    backgroundColor: transparent
    textColor: '#2c2c2f'
    rounded: 8px
    padding: 4px 12px
    height: 40px
    typography: 16px / 400 / 24px
    selected: 'bg #f2f2f3 on the current page item'
    hover: 'bg #f2f2f3'
    pressed: 'bg #eaeaeb'
    states: hover and pressed from settled bundle frames
    use: Left navigation items (홈, 캐릭터톡, 리퀘스트, 보관함) on home and @team, 240 x 40
  icon-button:
    type: button
    backgroundColor: transparent
    textColor: '#2c2c2f'
    rounded: 8px
    padding: 0px 4px
    size: 40px x 40px
    hover: 'bg #f2f2f3'
    pressed: 'bg #eaeaeb'
    disabled: 'fg #a4a4a8'
    states: hover and pressed from settled bundle frames; disabled from the attribute on a 32 x 32 pager arrow on @team
    use: Header icon buttons at home::[data-omd-capture="2"]
  tag-chip:
    type: badge
    backgroundColor: '#f2f2f3'
    textColor: '#62626a'
    rounded: 24px
    padding: 0px 6px
    height: 20px
    typography: 11px / 400 / 16.5px
    use: Tag chips under posts on home and @team (81 instances); the fill sits on the absolutely positioned a.pt-Chip-action
  filter-chip:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#2c2c2f'
    border: '1px solid #eaeaeb'
    rounded: 24px
    padding: 0px 14px
    height: 32px
    typography: 13px / 400 / 19.5px
    selected: 'bg #ebf2ff, fg #3478ff, border #dbe7fe'
    states: selected read from rest values; no pointer frame
    use: Filter chips beside the search field on @team
  menu-popup:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 8px
    shadow: rgba(21, 21, 21, 0.08) 0px 2px 8px -2px, rgba(21, 21, 21, 0.08) 0px 6px 12px -2px
    use: Overflow menus opened by the collector on post cards (four on home, four on @team)
  menu-item:
    type: listItem
    textColor: '#2c2c2f'
    rounded: 6px
    padding: 6px 12px
    height: 40px
    typography: 15px / 400 / 22.5px
    alert: 'fg #f33d4d on one item of each post menu (item 5 on home, item 4 on @team)'
    use: Items in the overflow menus
  recommend-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #eaeaeb'
    rounded: 12px
    padding: 16px
    size: 352px x 172px
    use: Bordered card in the home right column (pt-Card-root)
  notice-alert:
    type: toast
    backgroundColor: '#ebf2ff'
    textColor: '#1a66ff'
    border: '1px solid #dbe7fe'
    rounded: 12px
    padding: 12px 12px 12px 18px
    shadow: rgba(21, 21, 21, 0.08) 0px 2px 8px -2px, rgba(21, 21, 21, 0.08) 0px 6px 12px -2px
    size: 320px x 130px
    use: Blue notice (pt-Alert-root) in the home right column
  alert-button:
    type: button
    backgroundColor: '#3478ff'
    textColor: '#ffffff'
    rounded: 6px
    padding: 4px 12px
    height: 32px
    typography: 13px / 600 / 17.33px
    states: rest only
    use: The action inside the blue notice at home::[data-omd-capture="242"], 262 x 32; the only solid blue fill captured
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#2c2c2f'
    border: '1px solid #eaeaeb'
    rounded: 8px
    padding: 0px 8px
    height: 32px
    typography: 14px / 400 / 21px
    states: rest only
    use: Search field above the @team post list, 308 x 32
  feed-post:
    type: card
    border: 0 0 1px rgba(118, 118, 127, 0.15)
    padding: 20px 0px
    size: 640px wide
    use: Posts in the home feed, divided by a translucent bottom rule, no fill
  avatar:
    type: avatar
    rounded: 50%
    size: 40px x 40px
    use: Creator avatars in the feed; 24px and 20px sizes also occur
  promo-tile:
    type: card
    backgroundColor: '#1e1b3a'
    rounded: 8px
    size: 240px x 57px
    use: Dark promotional image tile in the home sidebar; the colour is the tile fill behind its artwork
fonts:
  roles:
    sans: Postype Sans-serif KR
---

# POSTYPE

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to POSTYPE; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/postype/DESIGN.md
